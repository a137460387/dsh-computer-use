"""Pause state machine and the background takeover monitor.

Two independent user-takeover signals pause desktop control:

- The takeover hotkey (polled via ``GetAsyncKeyState``) toggles pause/resume.
- Any user cursor movement or key press pauses, EXCEPT inside the
  agent-action in-flight window (one of click_at/type_text/scroll/hotkey
  currently executing), the short grace window after each action ends, and
  the startup grace window after the monitor arms — within those windows the
  sidecar's own synthetic input (or key state latched before startup) must
  not count.

While paused, the four action tools refuse with a marker-prefixed error;
screen_shot, get_display_info, resume_actions, and pause_actions keep
working (observation and pause management never change system state).

The state machine is platform-neutral and unit-testable; the monitor thread
is Windows-only pure ctypes (no new dependencies). Every transition invokes
the registered callback with the monotonic transition counter, which main.py
uses to push a JSON-RPC notification to the Node plugin.
"""

from __future__ import annotations

import sys
import threading
import time

PAUSED_MARKER = "[dsh-cu-paused]"

PAUSE_REASONS = ("hotkey", "user-input", "manual", "confirm")

_POLL_SECONDS = 0.05


def _log(message: str) -> None:
    print(f"[dsh-cu-server] pause monitor: {message}", file=sys.stderr, flush=True)


class PausedError(RuntimeError):
    """Raised when an action tool is called while desktop control is paused."""

    def __init__(self) -> None:
        super().__init__(
            f"{PAUSED_MARKER} desktop control is paused (the user took over). "
            "Press the takeover hotkey again or call resume_actions to resume; "
            "screen_shot and get_display_info stay available while paused."
        )


class PauseState:
    """Thread-safe pause/in-flight state machine.

    Transitions are idempotent: pausing while paused (and resuming while
    running) reports ``False`` and does not invoke the callback. Every real
    transition bumps a monotonic counter carried on the notification, so the
    Node plugin can order resumes against the pause it acked (the confirm
    gate's race guard); the callback runs INSIDE the lock so notifications
    reach the wire in transition order.
    """

    def __init__(self, on_transition=None) -> None:
        self._lock = threading.Lock()
        self._paused = False
        self._in_flight = 0
        self._last_action_end: float | None = None
        self._transition_seq = 0
        self._on_transition = on_transition

    @property
    def paused(self) -> bool:
        with self._lock:
            return self._paused

    @property
    def transition_seq(self) -> int:
        """Current value of the monotonic transition counter."""
        with self._lock:
            return self._transition_seq

    def pause(self, reason: str) -> bool:
        """Enter the paused state; True when this call caused the transition."""
        with self._lock:
            if self._paused:
                return False
            self._paused = True
            self._transition_seq += 1
            self._notify(True, reason, self._transition_seq)
        return True

    def resume(self, reason: str) -> bool:
        """Leave the paused state; True when this call caused the transition."""
        with self._lock:
            if not self._paused:
                return False
            self._paused = False
            self._transition_seq += 1
            self._notify(False, reason, self._transition_seq)
        return True

    def assert_running(self) -> None:
        """Refuse action execution while paused."""
        if self.paused:
            raise PausedError()

    def begin_action(self) -> None:
        """Enter the agent-action in-flight window (one nesting level each)."""
        with self._lock:
            self._in_flight += 1

    def end_action(self) -> None:
        """Leave one in-flight nesting level; the last one starts the grace.
        An unmatched end (no action in flight) is a no-op."""
        with self._lock:
            if self._in_flight == 0:
                return
            self._in_flight -= 1
            if self._in_flight == 0:
                self._last_action_end = time.monotonic()

    def input_suppressed(self, grace_ms: int) -> bool:
        """Whether user-input detection must stay off right now.

        True inside the in-flight window and for ``grace_ms`` after the last
        action ended (late-arriving synthetic input must not count as the
        user taking over).
        """
        with self._lock:
            if self._in_flight > 0:
                return True
            if self._last_action_end is None:
                return False
            return (time.monotonic() - self._last_action_end) * 1000 < grace_ms

    def _notify(self, paused: bool, reason: str, seq: int) -> None:
        if self._on_transition is not None:
            self._on_transition(paused, reason, seq)


class MonitorState:
    """Poll-by-poll takeover detection, free of platform calls (unit-testable).

    ``feed`` turns one poll's raw observations into at most one detection:

    - ``"hotkey"`` — the takeover combo was pressed (the caller toggles the
      pause state);
    - ``"user-input"`` — the cursor moved or a key went down outside every
      exemption window;
    - ``None`` — nothing detected.

    Startup handling: ``arm`` records the cursor baseline and opens the
    startup grace window; every detection is discarded until the window
    expires, so key state latched before the sidecar started (the keystrokes
    that launched it) never registers as the user taking over. Edge state
    (combo held, cursor position) keeps updating during the window, so a
    condition persisting across the window does not fire the moment it ends.
    """

    def __init__(self, startup_grace_ms: int, clock=time.monotonic) -> None:
        self._startup_grace_ms = startup_grace_ms
        self._clock = clock
        self._armed_at: float | None = None
        self._combo_was_down = False
        self._last_cursor: tuple[int, int] | None = None

    def arm(self, cursor: tuple[int, int] | None) -> None:
        """Open the startup grace window with the cursor baseline captured."""
        self._armed_at = self._clock()
        self._last_cursor = cursor

    def feed(
        self,
        *,
        combo_down: bool,
        key_down: bool,
        cursor: tuple[int, int] | None,
        pause_on_user_input: bool,
        paused: bool,
        suppressed: bool,
    ) -> str | None:
        """Decide one poll from raw observations; see the class docs."""
        if self._armed_at is None:
            return None
        if (self._clock() - self._armed_at) * 1000 < self._startup_grace_ms:
            self._combo_was_down = combo_down
            if cursor is not None:
                self._last_cursor = cursor
            return None

        detected: str | None = None
        if combo_down and not self._combo_was_down:
            detected = "hotkey"
        self._combo_was_down = combo_down

        moved = False
        if cursor is not None:
            if self._last_cursor is not None and cursor != self._last_cursor:
                moved = True
            self._last_cursor = cursor

        if (
            detected is None
            and pause_on_user_input
            and not paused
            and not combo_down  # still holding the takeover combo is not "typing"
            and not suppressed
            and (moved or key_down)
        ):
            detected = "user-input"
        return detected


# Virtual-key codes for the takeover-hotkey vocabulary (Windows). Single
# letters and digits resolve through ord(); F-keys through 0x70 + n - 1.
_VIRTUAL_KEYS: dict[str, int] = {
    "ctrl": 0x11,
    "control": 0x11,
    "alt": 0x12,
    "shift": 0x10,
    "win": 0x5B,
    "winleft": 0x5B,
    "winright": 0x5C,
    "super": 0x5B,
    "command": 0x5B,
    "esc": 0x1B,
    "escape": 0x1B,
    "enter": 0x0D,
    "return": 0x0D,
    "space": 0x20,
    "tab": 0x09,
    "backspace": 0x08,
    "delete": 0x2E,
    "del": 0x2E,
    "insert": 0x2D,
    "home": 0x24,
    "end": 0x23,
    "pageup": 0x21,
    "pagedown": 0x22,
    "up": 0x26,
    "down": 0x28,
    "left": 0x25,
    "right": 0x27,
    "capslock": 0x14,
    "printscreen": 0x2C,
    "pause": 0x13,
}


def resolve_hotkey_vks(names: list[str]) -> list[int]:
    """Map pyautogui-style key names to Windows virtual-key codes.

    Raises ``ValueError`` naming the first unknown key (fail loud at
    startup; the Node side surfaces the sidecar stderr on handshake failure).
    """
    vks: list[int] = []
    for name in names:
        key = name.strip().lower()
        if len(key) == 1 and key.isalnum():
            vks.append(ord(key.upper()))
        elif key in _VIRTUAL_KEYS:
            vks.append(_VIRTUAL_KEYS[key])
        elif key.startswith("f") and key[1:].isdigit() and 1 <= int(key[1:]) <= 24:
            vks.append(0x70 + int(key[1:]) - 1)
        else:
            raise ValueError(f"takeover hotkey: unknown key name {name!r}")
    return vks


def start_monitor(state: PauseState, monitor_config: dict) -> threading.Thread | None:
    """Start the background takeover monitor (Windows only).

    Polls ``GetAsyncKeyState`` for the takeover hotkey (toggle) and — when
    enabled and unsuppressed — for user cursor movement or any key press.
    Startup flushes every monitored key's "pressed since last call" latch,
    captures the cursor baseline, and discards all detections for the
    configured startup grace window. Returns the thread, or None on platforms
    without a ctypes backend (macOS: pause monitoring is unavailable;
    resume_actions still works).
    """
    if sys.platform != "win32":
        _log("Windows-only monitor unavailable on this platform; takeover hotkey and user-input pause are disabled")
        return None

    hotkey_vks = resolve_hotkey_vks(list(monitor_config.get("hotkey", [])))
    pause_on_user_input = bool(monitor_config.get("pause_on_user_input", True))
    grace_ms = int(monitor_config.get("grace_ms", 250))
    startup_grace_ms = int(monitor_config.get("startup_grace_ms", 500))

    import ctypes
    from ctypes import wintypes

    user32 = ctypes.windll.user32

    def _combo_down() -> bool:
        return bool(hotkey_vks) and all(user32.GetAsyncKeyState(vk) & 0x8000 for vk in hotkey_vks)

    def _any_key_down() -> bool:
        # 0x08..0xFE covers the keyboard VK range (mouse buttons excluded).
        return any(user32.GetAsyncKeyState(vk) & 0x8001 for vk in range(0x08, 0xFF))

    def _cursor_pos() -> tuple[int, int] | None:
        point = wintypes.POINT()
        if user32.GetCursorPos(ctypes.byref(point)):
            return (int(point.x), int(point.y))
        return None

    def _loop() -> None:
        # Flush the "pressed since last call" latch of every monitored key so
        # key state predating this process (the keystrokes that launched it)
        # does not register as user input.
        for vk in sorted(set(hotkey_vks) | set(range(0x08, 0xFF))):
            user32.GetAsyncKeyState(vk)
        # The cursor baseline precedes arming: detection only starts once the
        # startup grace window opens, and it compares against this position.
        monitor = MonitorState(startup_grace_ms)
        monitor.arm(_cursor_pos())
        while True:
            try:
                decision = monitor.feed(
                    combo_down=_combo_down(),
                    key_down=_any_key_down(),
                    cursor=_cursor_pos(),
                    pause_on_user_input=pause_on_user_input,
                    paused=state.paused,
                    suppressed=state.input_suppressed(grace_ms),
                )
                if decision == "hotkey":
                    if state.paused:
                        state.resume("hotkey")
                    else:
                        state.pause("hotkey")
                elif decision == "user-input":
                    state.pause("user-input")
            except Exception as error:  # keep the monitor alive across a bad poll
                _log(f"poll failed: {error}")
            time.sleep(_POLL_SECONDS)

    thread = threading.Thread(target=_loop, name="dsh-cu-pause-monitor", daemon=True)
    thread.start()
    _log(
        f"started (hotkey {'+'.join(monitor_config.get('hotkey', [])) or 'disabled'}, "
        f"user-input pause {'on' if pause_on_user_input else 'off'}, grace {grace_ms}ms, "
        f"startup grace {startup_grace_ms}ms)"
    )
    return thread
