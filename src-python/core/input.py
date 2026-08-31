"""Input actions: clicks, typing, scrolling, hotkeys.

Coordinates arriving here are ALREADY in the input API's operating space
(physical pixels on the PMv2-aware Windows process, logical CG points on
macOS) — this module performs no coordinate math of its own.

Typing: pyautogui covers ASCII; non-ASCII text on Windows goes through
SendInput KEYEVENTF_UNICODE (no clipboard round-trip). macOS non-ASCII is
refused with a clear error until a clipboard backend lands.
"""

from __future__ import annotations

import sys


def click(x: float, y: float) -> None:
    import pyautogui

    pyautogui.click(x, y)


def type_text(text: str) -> None:
    if not text:
        return
    if all(ord(ch) < 128 for ch in text):
        import pyautogui

        pyautogui.typewrite(text, interval=0.01)
        return
    if sys.platform == "win32":
        _windows_unicode_type(text)
        return
    raise ValueError(
        "non-ASCII input is not supported on macOS yet (pyautogui types ASCII only);"
        " use an ASCII payload or paste the text through a hotkey action"
    )


def _windows_unicode_type(text: str) -> None:
    """SendInput KEYEVENTF_UNICODE: one input event per character, no clipboard."""
    import ctypes
    from ctypes import wintypes

    INPUT_KEYBOARD = 1
    KEYEVENTF_UNICODE = 0x0004
    KEYEVENTF_KEYUP = 0x0002

    class KEYBDINPUT(ctypes.Structure):
        _fields_ = [
            ("wVk", wintypes.WORD),
            ("wScan", wintypes.WORD),
            ("dwFlags", wintypes.DWORD),
            ("time", wintypes.DWORD),
            ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong)),
        ]

    class INPUT_UNION(ctypes.Union):
        _fields_ = [("ki", KEYBDINPUT)]

    class INPUT(ctypes.Structure):
        _fields_ = [("type", wintypes.DWORD), ("union", INPUT_UNION)]

    def _event(char: str, flags: int) -> INPUT:
        event = INPUT()
        event.type = INPUT_KEYBOARD
        event.union.ki.wVk = 0
        event.union.ki.wScan = ord(char)
        event.union.ki.dwFlags = flags
        return event

    events = []
    for char in text:
        if ord(char) > 0xFFFF:
            # Encode astral characters as a UTF-16 surrogate pair.
            encoded = char.encode("utf-16-le")
            for index in range(0, len(encoded), 2):
                unit = int.from_bytes(encoded[index : index + 2], "little")
                events.append(_event(chr(unit), KEYEVENTF_UNICODE))
                events.append(_event(chr(unit), KEYEVENTF_UNICODE | KEYEVENTF_KEYUP))
            continue
        events.append(_event(char, KEYEVENTF_UNICODE))
        events.append(_event(char, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP))

    array = (INPUT * len(events))(*events)
    ctypes.windll.user32.SendInput(len(events), ctypes.byref(array), ctypes.sizeof(INPUT))


def scroll(direction: str, amount: int) -> None:
    import pyautogui

    if direction == "up":
        pyautogui.scroll(abs(amount))
    elif direction == "down":
        pyautogui.scroll(-abs(amount))
    elif direction in ("left", "right"):
        if sys.platform == "darwin":
            delta = abs(amount) if direction == "right" else -abs(amount)
            pyautogui.hscroll(delta)
        elif sys.platform == "win32":
            _windows_horizontal_scroll(direction, amount)
        else:
            raise ValueError(f"horizontal scroll is unsupported on {sys.platform}")
    else:
        raise ValueError(f"unknown scroll direction {direction!r}")


def _windows_horizontal_scroll(direction: str, amount: int) -> None:
    """Shift + mouse wheel: the Windows convention for horizontal scroll."""
    import ctypes
    from ctypes import wintypes

    INPUT_MOUSE = 0
    MOUSEEVENTF_WHEEL = 0x0800
    WHEEL_DELTA = 120

    class MOUSEINPUT(ctypes.Structure):
        _fields_ = [
            ("dx", wintypes.LONG),
            ("dy", wintypes.LONG),
            ("mouseData", wintypes.DWORD),
            ("dwFlags", wintypes.DWORD),
            ("time", wintypes.DWORD),
            ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong)),
        ]

    class INPUT_UNION(ctypes.Union):
        _fields_ = [("mi", MOUSEINPUT)]

    class INPUT(ctypes.Structure):
        _fields_ = [("type", wintypes.DWORD), ("union", INPUT_UNION)]

    import pyautogui

    pyautogui.keyDown("shift")
    try:
        notch = -abs(amount) if direction == "right" else abs(amount)
        event = INPUT()
        event.type = INPUT_MOUSE
        event.union.mi.mouseData = (notch * WHEEL_DELTA) & 0xFFFFFFFF
        event.union.mi.dwFlags = MOUSEEVENTF_WHEEL
        ctypes.windll.user32.SendInput(1, ctypes.byref(event), ctypes.sizeof(INPUT))
    finally:
        pyautogui.keyUp("shift")


def hotkey(keys: list[str]) -> None:
    import pyautogui

    pyautogui.hotkey(*keys)


def foreground_window_title() -> str | None:
    """Title of the foreground window, or None when the platform cannot
    read it with pure ctypes (macOS needs pyobjc; refused backends too).
    An empty string is a real title-less window, distinct from None."""
    if sys.platform != "win32":
        return None
    import ctypes

    user32 = ctypes.windll.user32
    hwnd = user32.GetForegroundWindow()
    if not hwnd:
        return ""
    buffer = ctypes.create_unicode_buffer(1024)
    user32.GetWindowTextW(hwnd, buffer, len(buffer))
    return str(buffer.value)


def foreground_process_name() -> str:
    """Basename of the process owning the foreground window."""
    if sys.platform == "win32":
        return _windows_foreground_name()
    if sys.platform == "darwin":
        return _macos_foreground_name()
    raise RuntimeError(f"no foreground-window backend for {sys.platform}")


def _windows_foreground_name() -> str:
    import ctypes
    import os
    from ctypes import wintypes

    user32 = ctypes.windll.user32
    hwnd = user32.GetForegroundWindow()
    pid = wintypes.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))

    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    handle = ctypes.windll.kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid.value)
    if not handle:
        return ""
    try:
        buffer = ctypes.create_unicode_buffer(1024)
        size = wintypes.DWORD(len(buffer))
        if ctypes.windll.kernel32.QueryFullProcessImageNameW(handle, 0, buffer, ctypes.byref(size)):
            return os.path.basename(buffer.value)
        return ""
    finally:
        ctypes.windll.kernel32.CloseHandle(handle)


def _macos_foreground_name() -> str:
    try:
        from AppKit import NSWorkspace
    except ImportError as error:
        raise RuntimeError("macOS foreground detection needs pyobjc-framework-AppKit") from error

    app = NSWorkspace.sharedWorkspace().frontmostApplication()
    return str(app.localizedName() or app.bundleIdentifier() or "")
