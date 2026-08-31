"""Unit tests for the zoom-crop capture path and its coordinate contracts:
region crops in core.screen, region-aware mapping in core.display, and the
region basis resolution in main's tool dispatch.

Pure-Python surfaces only (pyautogui is faked), so they run on every platform:

    python -m unittest discover -s tests/python -v
"""

from __future__ import annotations

import sys
import tempfile
import time
import types
import unittest
from pathlib import Path
from unittest import mock

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src-python"))

from core import display, screen  # noqa: E402
from core.pause import PauseState  # noqa: E402
from core.sensitive import SensitiveWindowPolicy  # noqa: E402

import main  # noqa: E402


def _fake_pyautogui(width: int = 2000, height: int = 1000) -> types.ModuleType:
    """A pyautogui stand-in whose screenshot() returns a solid-color frame."""
    fake = types.ModuleType("pyautogui")
    fake.screenshot = lambda region=None: Image.new("RGB", (width, height), (10, 20, 30))
    return fake


def _dispatch_config(archive_dir: str) -> dict:
    return {
        "archive_dir": archive_dir,
        "ttl_ms": 30_000,
        "monitor": {"hotkey": [], "pause_on_user_input": False, "grace_ms": 0, "startup_grace_ms": 0},
        "sensitive_policy": SensitiveWindowPolicy([], []),
        "pause_state": PauseState(),
    }


def _seed_observation(observation_id: str, facts: dict) -> None:
    screen._OBSERVATIONS[observation_id] = {
        "capturedAtMs": int(time.time() * 1000),
        "dhash": "0" * 16,
        "path": "unused",
        **facts,
    }


class CaptureScreenshotRegion(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.archive = self._tmp.name
        self.addCleanup(self._tmp.cleanup)

    def _capture(self, **kwargs) -> dict:
        with mock.patch.dict(sys.modules, {"pyautogui": _fake_pyautogui()}):
            return screen.capture_screenshot(
                archive_dir=self.archive,
                ttl_ms=30_000,
                max_width=kwargs.pop("max_width", None),
                quality=75,
                region=kwargs.pop("region", None),
                **kwargs,
            )

    def test_plain_capture_records_full_capture_geometry_without_region(self) -> None:
        result = self._capture()
        self.assertEqual((result["width"], result["height"]), (2000, 1000))
        self.assertNotIn("captureRegion", result)
        facts = screen._OBSERVATIONS[result["observationId"]]
        self.assertEqual((facts["captureWidth"], facts["captureHeight"]), (2000, 1000))
        self.assertNotIn("captureRegion", facts)

    def test_region_capture_crops_and_records_the_region(self) -> None:
        result = self._capture(region=(100, 50, 400, 200))
        self.assertEqual((result["width"], result["height"]), (400, 200))
        self.assertEqual(result["captureRegion"], {"x": 100, "y": 50, "width": 400, "height": 200})
        facts = screen._OBSERVATIONS[result["observationId"]]
        self.assertEqual(facts["captureRegion"], {"x": 100, "y": 50, "width": 400, "height": 200})
        self.assertEqual((facts["captureWidth"], facts["captureHeight"]), (2000, 1000))

    def test_region_capture_downscales_below_max_width_after_the_crop(self) -> None:
        result = self._capture(region=(0, 0, 800, 400), max_width=400)
        self.assertEqual((result["width"], result["height"]), (400, 200))
        facts = screen._OBSERVATIONS[result["observationId"]]
        # The recorded region stays in native capture pixels.
        self.assertEqual(facts["captureRegion"], {"x": 0, "y": 0, "width": 800, "height": 400})

    def test_region_outside_the_capture_is_refused(self) -> None:
        with self.assertRaisesRegex(ValueError, "outside"):
            self._capture(region=(1900, 950, 200, 100))

    def test_region_with_non_positive_size_is_refused(self) -> None:
        with self.assertRaisesRegex(ValueError, "positive size"):
            self._capture(region=(10, 10, 0, 100))

    def test_region_capture_is_refused_on_macos(self) -> None:
        with mock.patch.object(sys, "platform", "darwin"):
            with self.assertRaisesRegex(ValueError, "not implemented on macOS"):
                self._capture(region=(0, 0, 100, 100))


class RegionAwareMapping(unittest.TestCase):
    DISPLAYS = [display.DisplayInfo(id="A", x=0, y=0, width=2000, height=1000, scale_factor=1.0, is_primary=True)]

    def test_maps_within_the_capture_region_instead_of_the_full_screen(self) -> None:
        with mock.patch.object(sys, "platform", "win32"):
            px, py, target = display.screenshot_point_to_physical(
                200, 100, 400, 200, self.DISPLAYS, capture_region=(100, 50, 400, 200),
            )
        self.assertEqual((px, py), (300, 150))
        self.assertEqual(target.id, "A")

    def test_respects_crop_downscaling_when_mapping(self) -> None:
        with mock.patch.object(sys, "platform", "win32"):
            px, py, _ = display.screenshot_point_to_physical(
                100, 50, 200, 100, self.DISPLAYS, capture_region=(100, 50, 400, 200),
            )
        # Same physical point as the undownscaled crop above.
        self.assertEqual((px, py), (300, 150))

    def test_plain_mapping_is_unchanged_without_a_region(self) -> None:
        with mock.patch.object(sys, "platform", "win32"):
            px, py, _ = display.screenshot_point_to_physical(1000, 500, 2000, 1000, self.DISPLAYS)
        self.assertEqual((px, py), (1000, 500))

    def test_region_mapping_is_refused_on_macos(self) -> None:
        with mock.patch.object(sys, "platform", "darwin"):
            with self.assertRaisesRegex(ValueError, "not supported on macOS"):
                display.screenshot_point_to_physical(
                    10, 10, 100, 100, self.DISPLAYS, capture_region=(0, 0, 100, 100),
                )


class DispatchRegionProtocol(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.config = _dispatch_config(self._tmp.name)
        # The dispatch tests share the module-global observation store.
        self.addCleanup(screen._OBSERVATIONS.clear)

    def test_screen_shot_scales_the_region_basis_into_native_pixels(self) -> None:
        # Basis captured 100x50 from a 2000x1000 screen: 20x scale.
        _seed_observation("basis-1", {"width": 100, "height": 50, "captureWidth": 2000, "captureHeight": 1000})
        with mock.patch.dict(sys.modules, {"pyautogui": _fake_pyautogui()}):
            result = main._dispatch_tool("screen_shot", {
                "region": {"x": 10, "y": 5, "width": 40, "height": 20},
                "regionOfObservationId": "basis-1",
            }, self.config)
        self.assertEqual(result["captureRegion"], {"x": 200, "y": 100, "width": 800, "height": 400})
        self.assertEqual((result["width"], result["height"]), (800, 400))

    def test_region_and_basis_must_travel_together(self) -> None:
        with self.assertRaisesRegex(ValueError, "supplied together"):
            main._dispatch_tool("screen_shot", {"region": {"x": 0, "y": 0, "width": 10, "height": 10}}, self.config)
        with self.assertRaisesRegex(ValueError, "supplied together"):
            main._dispatch_tool("screen_shot", {"regionOfObservationId": "basis-1"}, self.config)

    def test_region_of_region_is_refused(self) -> None:
        _seed_observation("crop-1", {
            "width": 100, "height": 50, "captureWidth": 2000, "captureHeight": 1000,
            "captureRegion": {"x": 0, "y": 0, "width": 100, "height": 50},
        })
        with self.assertRaisesRegex(ValueError, "cannot serve as the basis"):
            main._dispatch_tool("screen_shot", {
                "region": {"x": 0, "y": 0, "width": 10, "height": 10},
                "regionOfObservationId": "crop-1",
            }, self.config)

    def test_basis_without_capture_geometry_is_refused(self) -> None:
        _seed_observation("legacy-1", {"width": 100, "height": 50})
        with self.assertRaisesRegex(ValueError, "capture geometry"):
            main._dispatch_tool("screen_shot", {
                "region": {"x": 0, "y": 0, "width": 10, "height": 10},
                "regionOfObservationId": "legacy-1",
            }, self.config)

    def test_click_on_a_crop_observation_maps_through_the_region(self) -> None:
        _seed_observation("crop-1", {
            "width": 320, "height": 180, "captureWidth": 1280, "captureHeight": 720,
            "captureRegion": {"x": 480, "y": 270, "width": 320, "height": 180},
        })
        displays = [display.DisplayInfo(id="A", x=0, y=0, width=1280, height=720, scale_factor=1.0, is_primary=True)]
        clicks: list[tuple[float, float]] = []
        with mock.patch.object(display, "get_displays", return_value=displays), \
             mock.patch("core.input.click", side_effect=lambda x, y: clicks.append((x, y))):
            result = main._dispatch_tool("click_at", {
                "x": 160, "y": 90, "screenshotWidth": 320, "screenshotHeight": 180,
                "basedOnObservationId": "crop-1",
            }, self.config)
        self.assertEqual((result["physicalX"], result["physicalY"]), (640, 360))
        self.assertEqual(clicks, [(640, 360)])

    def test_click_on_a_crop_observation_refuses_a_declared_basis_mismatch(self) -> None:
        _seed_observation("crop-1", {
            "width": 320, "height": 180, "captureWidth": 1280, "captureHeight": 720,
            "captureRegion": {"x": 480, "y": 270, "width": 320, "height": 180},
        })
        displays = [display.DisplayInfo(id="A", x=0, y=0, width=1280, height=720, scale_factor=1.0, is_primary=True)]
        with mock.patch.object(display, "get_displays", return_value=displays):
            with self.assertRaisesRegex(ValueError, "basis mismatch"):
                main._dispatch_tool("click_at", {
                    "x": 10, "y": 10, "screenshotWidth": 640, "screenshotHeight": 360,
                    "basedOnObservationId": "crop-1",
                }, self.config)


if __name__ == "__main__":
    unittest.main()
