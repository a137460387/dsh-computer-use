"""Unit tests for the synthetic cursor overlay (core/cursor_overlay.py).

Pure-Pillow surface — no capture, input, or ctypes calls — so the tests run
on every platform:

    python -m unittest discover -s tests/python -v

Running this file directly additionally renders sample frames with cursors
and labels into a temp directory for visual inspection.
"""

from __future__ import annotations

import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src-python"))

from PIL import Image  # noqa: E402

from core.cursor_overlay import (  # noqa: E402
    FILL_ALPHA,
    cursor_scale,
    draw_cursor_overlay,
)

WHITE = (255, 255, 255)
CYAN = (0, 229, 255)  # DEFAULT_COLOR #00E5FF


def solid(width: int, height: int, rgb: tuple[int, int, int] = WHITE) -> Image.Image:
    return Image.new("RGB", (width, height), rgb)


def changed_bbox(left: Image.Image, right: Image.Image) -> tuple[int, int, int, int] | None:
    """Bounding box of the differing pixels between two same-size images."""
    assert left.size == right.size
    lp = left.convert("RGB").load()
    rp = right.convert("RGB").load()
    xs: list[int] = []
    ys: list[int] = []
    for y in range(left.height):
        for x in range(left.width):
            if lp[x, y] != rp[x, y]:
                xs.append(x)
                ys.append(y)
    if not xs:
        return None
    return (min(xs), min(ys), max(xs), max(ys))


class CursorOverlayBasics(unittest.TestCase):
    def test_returns_new_image_same_size_and_mode(self) -> None:
        original = solid(400, 300)
        snapshot = original.copy()
        result = draw_cursor_overlay(original, 100, 80)
        self.assertIsNot(result, original)
        self.assertEqual(result.size, original.size)
        self.assertEqual(result.mode, "RGB")
        self.assertEqual(list(original.getdata()), list(snapshot.getdata()))

    def test_rgba_input_returns_rgba(self) -> None:
        original = Image.new("RGBA", (200, 150), WHITE + (255,))
        result = draw_cursor_overlay(original, 50, 40)
        self.assertEqual(result.mode, "RGBA")
        self.assertEqual(result.size, original.size)

    def test_draws_near_the_tip_and_leaves_distant_pixels_untouched(self) -> None:
        original = solid(400, 300)
        result = draw_cursor_overlay(original, 100, 80)
        bbox = changed_bbox(original, result)
        self.assertIsNotNone(bbox)
        left, top, right, bottom = bbox
        # The tip (hotspot) sits at the requested point.
        self.assertLessEqual(left, 100)
        self.assertLessEqual(top, 80)
        # The base cursor at scale 1 stays inside ~16x24 plus outline width.
        self.assertLessEqual(right - left, 20)
        self.assertLessEqual(bottom - top, 28)
        # Distant pixels are untouched.
        self.assertEqual(result.getpixel((300, 250)), WHITE)
        self.assertEqual(result.getpixel((5, 290)), WHITE)

    def test_tip_pixel_is_the_dark_outline(self) -> None:
        result = draw_cursor_overlay(solid(400, 300), 100, 80)
        r, g, b = result.getpixel((100, 80))[:3]
        self.assertLess(r, 60)
        self.assertLess(g, 60)
        self.assertLess(b, 60)

    def test_fill_is_alpha_blended_over_the_background(self) -> None:
        result = draw_cursor_overlay(solid(400, 300), 100, 80)
        # (102, 88) is interior to the arrow body at scale 1: over white the
        # translucent cyan blends to a predictable value, never pure cyan.
        r, g, b = result.getpixel((102, 88))[:3]
        alpha = FILL_ALPHA / 255
        expected = tuple(round(c * alpha + 255 * (1 - alpha)) for c in CYAN)
        self.assertGreater(r, 20)  # white bleeds through the translucent fill
        for channel, expect in zip((r, g, b), expected):
            self.assertAlmostEqual(channel, expect, delta=6)


class CursorScaling(unittest.TestCase):
    def test_cursor_scale_auto_scales_with_width(self) -> None:
        self.assertAlmostEqual(cursor_scale(solid(1280, 720), 1.0), 1.0)
        self.assertAlmostEqual(cursor_scale(solid(2560, 1440), 1.0), 2.0)
        # Below the reference width the floor keeps the cursor visible.
        self.assertAlmostEqual(cursor_scale(solid(640, 360), 1.0), 1.0)
        self.assertAlmostEqual(cursor_scale(solid(1280, 720), 2.5), 2.5)

    def test_cursor_scale_rejects_non_positive_scale(self) -> None:
        with self.assertRaises(ValueError):
            cursor_scale(solid(100, 100), 0.0)
        with self.assertRaises(ValueError):
            cursor_scale(solid(100, 100), -1.0)

    def test_larger_scale_draws_a_larger_cursor(self) -> None:
        small = draw_cursor_overlay(solid(400, 300), 100, 80, scale=1.0)
        large = draw_cursor_overlay(solid(400, 300), 100, 80, scale=3.0)
        base = solid(400, 300)
        small_box = changed_bbox(base, small)
        large_box = changed_bbox(base, large)
        assert small_box is not None and large_box is not None
        small_area = (small_box[2] - small_box[0]) * (small_box[3] - small_box[1])
        large_area = (large_box[2] - large_box[0]) * (large_box[3] - large_box[1])
        self.assertGreater(large_area, small_area * 4)

    def test_wider_image_auto_scales_the_cursor_up(self) -> None:
        # Same scale parameter, two capture sizes: the 2560-wide frame (the
        # DPI case where physical 2560x1440 stays uncropped) draws a cursor
        # roughly twice as tall as the 1280-wide frame.
        hd = draw_cursor_overlay(solid(1280, 720), 640, 360)
        qhd = draw_cursor_overlay(solid(2560, 1440), 1280, 720)
        hd_box = changed_bbox(solid(1280, 720), hd)
        qhd_box = changed_bbox(solid(2560, 1440), qhd)
        assert hd_box is not None and qhd_box is not None
        hd_h = hd_box[3] - hd_box[1]
        qhd_h = qhd_box[3] - qhd_box[1]
        self.assertGreater(qhd_h, hd_h * 1.7)


class CursorLabel(unittest.TestCase):
    def test_label_extends_the_drawn_area_beside_the_cursor(self) -> None:
        base = solid(400, 300)
        bare = draw_cursor_overlay(base, 100, 80)
        labeled = draw_cursor_overlay(base, 100, 80, label="(100, 80)")
        bare_box = changed_bbox(base, bare)
        labeled_box = changed_bbox(base, labeled)
        assert bare_box is not None and labeled_box is not None
        self.assertGreater(labeled_box[2], bare_box[2] + 10)

    def test_label_flips_left_near_the_right_edge(self) -> None:
        base = solid(400, 300)
        bare = draw_cursor_overlay(base, 390, 80)
        labeled = draw_cursor_overlay(base, 390, 80, label="(390, 80)")
        bare_box = changed_bbox(base, bare)
        labeled_box = changed_bbox(base, labeled)
        assert bare_box is not None and labeled_box is not None
        # The backdrop must stay inside the frame and move left of the tip.
        self.assertLessEqual(labeled_box[2], 399)
        self.assertLess(labeled_box[0], bare_box[0])

    def test_empty_label_is_no_label(self) -> None:
        base = solid(400, 300)
        bare = draw_cursor_overlay(base, 100, 80)
        empty = draw_cursor_overlay(base, 100, 80, label="")
        self.assertEqual(list(bare.getdata()), list(empty.getdata()))


class CursorEdgeCases(unittest.TestCase):
    def test_out_of_bounds_points_clip_without_raising(self) -> None:
        for point in ((0, 0), (399, 299), (-50, -50), (450, 350), (100, -20)):
            result = draw_cursor_overlay(solid(400, 300), *point)
            self.assertEqual(result.size, (400, 300))

    def test_invalid_color_raises_value_error(self) -> None:
        with self.assertRaises(ValueError):
            draw_cursor_overlay(solid(100, 100), 10, 10, color="not-a-color")
        with self.assertRaises(ValueError):
            draw_cursor_overlay(solid(100, 100), 10, 10, outline="nope")

    def test_custom_colors_reach_the_frame(self) -> None:
        result = draw_cursor_overlay(solid(400, 300), 100, 80, color="#FF0000", outline="#FFFFFF")
        # Some interior pixel must carry a red-dominant blend.
        pixels = list(result.getdata())
        self.assertTrue(any(p[0] > 150 and p[0] > p[2] * 2 for p in pixels))

    def test_drawing_stays_under_50ms_for_a_1280x720_frame(self) -> None:
        image = solid(1280, 720, rgb=(120, 140, 160))
        draw_cursor_overlay(image, 640, 360)  # warm-up: lazy PIL internals
        started = time.perf_counter()
        draw_cursor_overlay(image, 640, 360)
        elapsed_ms = (time.perf_counter() - started) * 1000
        self.assertLess(elapsed_ms, 50)


def render_samples() -> None:
    """Visual check: gradient frames with cursors, labels, and DPI scaling."""
    import tempfile

    def gradient(width: int, height: int) -> Image.Image:
        image = Image.new("RGB", (width, height))
        pixels = image.load()
        for y in range(height):
            for x in range(width):
                pixels[x, y] = (x * 255 // width, y * 255 // height, 128)
        return image

    out_dir = Path(tempfile.mkdtemp(prefix="dsh-cu-cursor-"))
    hd = draw_cursor_overlay(gradient(1280, 720), 100, 200, label="(100, 200)")
    hd = draw_cursor_overlay(hd, 640, 360, scale=2.0, label="(640, 360) scale=2")
    hd = draw_cursor_overlay(hd, 1270, 700, label="(1270, 700)")
    hd.save(out_dir / "cursor-1280x720.png")
    qhd = draw_cursor_overlay(gradient(2560, 1440), 200, 400, label="(200, 400)")
    qhd.save(out_dir / "cursor-2560x1440.png")
    print(f"sample frames written to {out_dir}")


if __name__ == "__main__":
    if "--demo" in sys.argv:
        sys.argv.remove("--demo")
        render_samples()
    unittest.main()
