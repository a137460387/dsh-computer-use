"""Pause state machine and the background takeover monitor.

Two independent user-takeover signals pause desktop control:

- The takeover hotkey (polled via ``GetAsyncKeyState``) toggles pause/resume.
- Any user cursor movement or key press pauses, EXCEPT inside the
  agent-action in-flight window (one of click_at/type_text/scroll/hotkey
  currently executing) and a short grace window after each action ends —
  within those windows the sidecar's own synthetic input must not count.

While paused, the four action tools refuse with a marker-prefixed error;
screen_shot, get_display_info, resume_actions, and pause_actions keep
working (observation and pause management never change system state).

The state machine is platform-neutral and unit-testable; the monitor thread
is Windows-only pure ctypes (no new dependencies). Every transition invokes
the registered callback, which main.py uses to push a JSON-RPC notification
to the Node plugin.
"""

from __future__ import annotations

import sys
import threading
import time

PAUSED_MARKER = "[dsh-cu-paused]"

PAUSE_REASONS = ("hotkey", "user-input", "manual")

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
    running) reports ``False`` and does not invoke the callback.
    """

    def __init__(self, on_transition=None) -> None:
        self._lock = threading.Lock()
        self._paused = False
        self._in_flight = 0
        self._last_action_end: float | None = None
        self._on_transition = on_transition

    @property
    def paused(self) -> bool:
        with self._lock:
            return self._paused

    def pause(self, reason: str) -> bool:
        """Enter the paused state; True when this call caused the transition."""
        with self._lock:
            if self._paused:
                return False
            self._paused = True
        self._notify(True, reason)
        return True

    def resume(self, reason: str) -> bool:
        """Leave the paused state; True when this call caused the transition."""
        with self._lock:
            if not self._paused:
                return False
            self._paused = False
        self._notify(False, reason)
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

    def _notify(self, paused: bool, reason: str) -> None:
        if self._on_transition is not None:
            self._on_transition(paused, reason)


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
    Returns the thread, or None on platforms without a ctypes backend
    (macOS: pause monitoring is unavailable; resume_actions still works).
    """
    if sys.platform != "win32":
        _log("Windows-only monitor unavailable on this platform; takeover hotkey and user-input pause are disabled")
        return None

    hotkey_vks = resolve_hotkey_vks(list(monitor_config.get("hotkey", [])))
    pause_on_user_input = bool(monitor_config.get("pause_on_user_input", True))
    grace_ms = int(monitor_config.get("grace_ms", 250))

    import ctypes
    from ctypes import wintypes

    user32 = ctypes.windll.user32

    def _combo_down() -> bool:
        return bool(hotkey_vks) and all(user32.GetAsyncKeyState(vk) & 0x8000 for vk in hotkey_vks)

    def _any_key_down() -> bool:
        # 0x08..0xFE covers the keyboard VK range (mouse buttons excluded).
        return any(user32.GetAsyncKeyState(vk) & 0x8001 for vk in range(0x08, 0xFF))

    def _loop() -> None:
        # Flush the first-query latch of the "pressed since last call" bit so
        # key state predating this process does not register as user input.
        _any_key_down()
        combo_was_down = False
        last_pos: tuple[int, int] | None = None
        while True:
            try:
                combo_down = _combo_down()
                if combo_down and not combo_was_down:
                    if state.paused:
                        state.resume("hotkey")
                    else:
                        state.pause("hotkey")
                combo_was_down = combo_down

                if (
                    pause_on_user_input
                    and not state.paused
                    and not combo_down  # still holding the takeover combo is not "typing"
                    and not state.input_suppressed(grace_ms)
                ):
                    moved = False
                    point = wintypes.POINT()
                    if user32.GetCursorPos(ctypes.byref(point)):
                        position = (int(point.x), int(point.y))
                        if last_pos is not None and position != last_pos:
                            moved = True
                        last_pos = position
                    if moved or _any_key_down():
                        state.pause("user-input")
            except Exception as error:  # keep the monitor alive across a bad poll
                _log(f"poll failed: {error}")
            time.sleep(_POLL_SECONDS)

    thread = threading.Thread(target=_loop, name="dsh-cu-pause-monitor", daemon=True)
    thread.start()
    _log(
        f"started (hotkey {'+'.join(monitor_config.get('hotkey', [])) or 'disabled'}, "
        f"user-input pause {'on' if pause_on_user_input else 'off'}, grace {grace_ms}ms)"
    )
    return thread
