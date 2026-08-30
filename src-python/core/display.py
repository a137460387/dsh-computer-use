"""DPI-aware display enumeration and the two-stage coordinate mapping.

Coordinate model
----------------
The Node plugin sends VLM coordinates in SCREENSHOT space (pixels of the
captured, downscaled image) plus that screenshot's dimensions. Mapping to a
physical click happens in two stages, never one global scale factor:

1. Restore the captured virtual screen: scale the screenshot point back into
   the full-resolution virtual screen the capture covered.
2. Convert into the input API's operating space with the LOCAL scale factor
   of the display the point landed on — mixed-DPI setups have one scale per
   display, so the target display is resolved first and only its factor is
   applied.

Windows runs this process Per-Monitor V2 DPI aware, so the virtual screen is
already expressed in physical pixels and pyautogui consumes them directly;
the per-display stage still resolves the target display (bounds clamping and
whitelist facts). macOS CG coordinates are logical points, so stage two divides
by the target display's backingScaleFactor.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass


@dataclass(frozen=True)
class DisplayInfo:
    """One attached display in the virtual-screen coordinate space."""

    id: str
    x: int
    y: int
    width: int
    height: int
    scale_factor: float
    is_primary: bool

    def contains(self, px: float, py: float) -> bool:
        return (
            self.x <= px < self.x + self.width
            and self.y <= py < self.y + self.height
        )

    def as_dict(self) -> dict:
        return {
            "id": self.id,
            "bounds": {"x": self.x, "y": self.y, "width": self.width, "height": self.height},
            "scaleFactor": self.scale_factor,
            "isPrimary": self.is_primary,
        }


_DPI_AWARENESS_ENABLED = False


def assert_interactive_session() -> None:
    """Refuse to run outside the interactive desktop session (Windows).

    A service-session process (session 0) sees a disconnected fallback
    display, cannot capture the user's screen, and its synthetic input never
    reaches the interactive desktop — desktop control from there is
    structurally impossible. Fail loud with the remedy instead of serving
    doomed captures.
    """
    if sys.platform != "win32":
        return
    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.windll.kernel32
    pid = kernel32.GetCurrentProcessId()
    session_id = wintypes.DWORD()
    kernel32.ProcessIdToSessionId(pid, ctypes.byref(session_id))
    console_session = kernel32.WTSGetActiveConsoleSessionId()
    if console_session == 0xFFFFFFFF:
        raise RuntimeError(
            "no active interactive desktop session was found; "
            "desktop control needs a logged-in interactive user"
        )
    if session_id.value != console_session:
        raise RuntimeError(
            f"this process runs in Windows session {session_id.value} but the interactive "
            f"desktop is session {console_session}; desktop control needs the harness itself "
            "to run inside the interactive session (launch dsh from a desktop terminal instead "
            "of a background service)"
        )


def enable_dpi_awareness() -> None:
    """Make this process Per-Monitor V2 DPI aware (Windows), idempotent.

    Must run before any capture or coordinate math; without it Windows
    virtualizes coordinates and every mapping below silently drifts.
    """
    global _DPI_AWARENESS_ENABLED
    if _DPI_AWARENESS_ENABLED or sys.platform != "win32":
        return
    import ctypes

    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)  # PROCESS_PER_MONITOR_DPI_AWARE_V2
    except Exception:
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except Exception:
            pass
    _DPI_AWARENESS_ENABLED = True


def get_displays() -> list[DisplayInfo]:
    """Every attached display with physical bounds and its local scale factor."""
    enable_dpi_awareness()
    if sys.platform == "win32":
        return _windows_displays()
    if sys.platform == "darwin":
        return _macos_displays()
    raise RuntimeError(f"no display backend for platform {sys.platform!r}")


def _windows_displays() -> list[DisplayInfo]:
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.windll.user32
    shcore = ctypes.windll.shcore

    class MONITORINFOEXW(ctypes.Structure):
        _fields_ = [
            ("cbSize", wintypes.DWORD),
            ("rcMonitor", wintypes.RECT),
            ("rcWork", wintypes.RECT),
            ("dwFlags", wintypes.DWORD),
            ("szDevice", wintypes.WCHAR * 32),
        ]

    MONITORINFOF_PRIMARY = 0x00000001
    MDT_EFFECTIVE_DPI = 0

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HMONITOR, wintypes.HDC, ctypes.POINTER(wintypes.RECT), wintypes.LPARAM)
    def _collect(handle, _hdc, _rect, _param):
        info = MONITORINFOEXW()
        info.cbSize = ctypes.sizeof(MONITORINFOEXW)
        if user32.GetMonitorInfoW(handle, ctypes.byref(info)):
            dpi_x = wintypes.UINT(96)
            dpi_y = wintypes.UINT(96)
            try:
                shcore.GetDpiForMonitor(handle, MDT_EFFECTIVE_DPI, ctypes.byref(dpi_x), ctypes.byref(dpi_y))
            except Exception:
                pass
            rect = info.rcMonitor
            _displays.append(DisplayInfo(
                id=str(info.szDevice),
                x=int(rect.left),
                y=int(rect.top),
                width=int(rect.right - rect.left),
                height=int(rect.bottom - rect.top),
                scale_factor=float(dpi_x.value) / 96.0,
                is_primary=bool(info.dwFlags & MONITORINFOF_PRIMARY),
            ))
        return True

    _displays: list[DisplayInfo] = []
    user32.EnumDisplayMonitors(None, None, _collect, 0)
    if not _displays:
        raise RuntimeError("EnumDisplayMonitors reported no displays")
    return _displays


def _macos_displays() -> list[DisplayInfo]:
    try:
        import Quartz
        from AppKit import NSScreen
    except ImportError as error:
        raise RuntimeError(
            "macOS display enumeration needs pyobjc-framework-Quartz and pyobjc-framework-AppKit"
        ) from error

    err, display_ids = Quartz.CGGetActiveDisplayList(32, None, None)
    if err != 0:
        raise RuntimeError(f"CGGetActiveDisplayList failed with {err}")

    # Logical CG frame per display, plus its backing scale matched by origin.
    screens = {
        (screen.frame().origin.x, screen.frame().origin.y): float(screen.backingScaleFactor())
        for screen in NSScreen.screens()
    }
    displays: list[DisplayInfo] = []
    for index, display_id in enumerate(display_ids):
        frame = Quartz.CGDisplayBounds(display_id)
        scale = screens.get((frame.origin.x, frame.origin.y), 2.0 if Quartz.CGDisplayIsBuiltin(display_id) else 1.0)
        displays.append(DisplayInfo(
            id=str(display_id),
            x=int(frame.origin.x),
            y=int(frame.origin.y),
            width=int(frame.size.width),
            height=int(frame.size.height),
            scale_factor=scale,
            is_primary=bool(Quartz.CGDisplayIsMain(display_id)),
        ))
    if not displays:
        raise RuntimeError("CGGetActiveDisplayList reported no displays")
    return displays


def _primary(displays: list[DisplayInfo]) -> DisplayInfo:
    for display in displays:
        if display.is_primary:
            return display
    return displays[0]


def _nearest(display: DisplayInfo, px: float, py: float) -> float:
    """Squared distance from a point to a display rectangle (0 when inside)."""
    dx = max(display.x - px, 0.0, px - (display.x + display.width))
    dy = max(display.y - py, 0.0, py - (display.y + display.height))
    return dx * dx + dy * dy


def screenshot_point_to_physical(
    x: float,
    y: float,
    screenshot_width: int,
    screenshot_height: int,
    displays: list[DisplayInfo],
) -> tuple[float, float, DisplayInfo]:
    """Map one screenshot-space point into the input API's coordinate space.

    Stage one scales the point into the virtual screen the capture covered;
    stage two resolves the target display and applies THAT display's local
    scale. Returns the mapped point and the display it landed on.
    """
    if screenshot_width <= 0 or screenshot_height <= 0:
        raise ValueError("screenshot dimensions must be positive")
    if not displays:
        raise ValueError("no displays available")

    if sys.platform == "darwin":
        return _macos_map(x, y, screenshot_width, screenshot_height, displays)

    # Windows: the PMv2-aware virtual screen is one physical-pixel space.
    virtual_x = min(d.x for d in displays)
    virtual_y = min(d.y for d in displays)
    virtual_w = max(d.x + d.width for d in displays) - virtual_x
    virtual_h = max(d.y + d.height for d in displays) - virtual_y
    px = virtual_x + x * virtual_w / screenshot_width
    py = virtual_y + y * virtual_h / screenshot_height

    target = next((d for d in displays if d.contains(px, py)), None)
    if target is None:
        target = min(displays, key=lambda d: _nearest(d, px, py))
    # Clamp rounding drift into the target display's physical bounds.
    px = min(max(px, target.x), target.x + target.width - 1)
    py = min(max(py, target.y), target.y + target.height - 1)
    return px, py, target


def _macos_map(
    x: float,
    y: float,
    screenshot_width: int,
    screenshot_height: int,
    displays: list[DisplayInfo],
) -> tuple[float, float, DisplayInfo]:
    """macOS: screenshot pixels → logical CG points of the captured display.

    pyautogui captures the PRIMARY display only on macOS, so the screenshot
    covers that one display: scale the point into its logical bounds, then
    divide by that display's backingScaleFactor — never a global factor.
    """
    target = _primary(displays)
    logical_x = target.x + x * target.width / screenshot_width
    logical_y = target.y + y * target.height / screenshot_height
    return logical_x, logical_y, target
