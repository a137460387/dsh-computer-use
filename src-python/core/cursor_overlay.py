"""Synthetic cursor overlay for screenshot observations.

Draws a translucent arrow cursor at an intended point onto a COPY of a
captured frame without touching the real OS pointer: the overlay shows where
the agent plans to click (peek_cursor previews, click_at pre-click previews),
while the physical click still moves the real cursor through pyautogui.

Coordinate basis: the point is expressed in the image's own pixel space — the
same screenshot space click_at consumes. Cursor size auto-scales with the
image width relative to REFERENCE_WIDTH, so a capture downscaled to 1280 px
and a raw 2560 px capture carry proportionally sized cursors.
"""

from __future__ import annotations

from PIL import Image, ImageDraw, ImageFont

# Default cursor colors: bright cyan to stay clearly distinct from the OS's
# white pointer, black outline for contrast on any background.
DEFAULT_COLOR = "#00E5FF"
DEFAULT_OUTLINE = "#000000"

# Fill alpha 0-255: opaque enough to locate instantly, translucent enough to
# keep the underlying UI legible beneath the arrow body.
FILL_ALPHA = 190

# Image width at which scale=1.0 draws the ~16x24 base cursor. Matches the
# default screenshotMaxWidth, so downscaled captures keep the base size.
REFERENCE_WIDTH = 1280

# Classic upper-left arrow silhouette on a ~16x24 grid; the first vertex is
# the tip (the pointer hotspot the coordinates refer to).
_ARROW_POINTS: tuple[tuple[float, float], ...] = (
    (0.0, 0.0),      # tip / hotspot
    (0.0, 17.5),     # left edge
    (4.6, 13.4),     # notch where the tail starts
    (7.2, 19.8),     # tail bottom-left
    (9.9, 18.6),     # tail bottom-right
    (7.3, 12.2),     # tail top
    (13.2, 12.2),    # right wing
)


def cursor_scale(image: Image.Image, scale: float) -> float:
    """Effective cursor scale for one image: requested scale times the width
    factor against REFERENCE_WIDTH (never below 1.0, so tiny test images keep
    a visible cursor)."""
    if scale <= 0:
        raise ValueError(f"cursor scale must be positive, got {scale}")
    auto = max(1.0, image.width / REFERENCE_WIDTH)
    return scale * auto


def _label_font() -> ImageFont.ImageFont:
    """The built-in bitmap font at ~12 px when Pillow supports sizing."""
    try:
        return ImageFont.load_default(size=12)
    except TypeError:  # Pillow < 10.1 ships load_default() without a size knob
        return ImageFont.load_default()


def draw_cursor_overlay(
    image: Image.Image,
    x: int,
    y: int,
    *,
    scale: float = 1.0,
    color: str = DEFAULT_COLOR,
    outline: str = DEFAULT_OUTLINE,
    label: str | None = None,
) -> Image.Image:
    """Alpha-blend a synthetic arrow cursor at (x, y); the source image stays
    untouched and a new image in the same mode is returned.

    x, y mark the arrow TIP in image pixels (the point a subsequent click_at
    would act on). Points outside the image are accepted; drawing clips at the
    image edges. An optional label renders beside the cursor with a
    translucent backdrop box.
    """
    from PIL import ImageColor

    s = cursor_scale(image, float(scale))
    fill_rgb = ImageColor.getrgb(color)
    outline_rgb = ImageColor.getrgb(outline)

    overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)

    points = [(x + px * s, y + py * s) for px, py in _ARROW_POINTS]
    draw.polygon(
        points,
        fill=(fill_rgb[0], fill_rgb[1], fill_rgb[2], FILL_ALPHA),
        outline=(outline_rgb[0], outline_rgb[1], outline_rgb[2], 255),
        width=max(1, round(s)),
    )

    if label:
        _draw_label(draw, overlay.size, label, x, y, s)

    composited = Image.alpha_composite(image.convert("RGBA"), overlay)
    if image.mode == "RGBA":
        return composited
    return composited.convert(image.mode)


def _draw_label(
    draw: ImageDraw.ImageDraw,
    size: tuple[int, int],
    label: str,
    x: int,
    y: int,
    s: float,
) -> None:
    """Coordinate label with a translucent backdrop, kept inside the frame."""
    font = _label_font()
    left, top, right, bottom = draw.textbbox((0, 0), label, font=font)
    text_w = right - left
    text_h = bottom - top
    pad = 3
    box_w = text_w + pad * 2

    box_x = x + 16 * s + 6
    if box_x + box_w > size[0]:
        box_x = max(0, x - box_w - 6)  # flip left of the cursor near the right edge
    box_y = min(max(0, int(y)), max(0, size[1] - text_h - pad * 2))

    draw.rounded_rectangle(
        (box_x, box_y, box_x + box_w, box_y + text_h + pad * 2),
        radius=3,
        fill=(0, 0, 0, 160),
    )
    draw.text((box_x + pad - left, box_y + pad - top), label, font=font, fill=(255, 255, 255, 255))
