"""Screenshot capture, JPEG compression, dHash fingerprints, observations.

The capture covers the virtual screen (all displays on Windows, the primary
display on macOS — pyautogui's capture behavior), is downscaled below a
max-width budget aligned with VLM input sizes, JPEG-compressed, archived to
disk, and registered as a freshness-tracked observation. The Node plugin
reads the archived file directly; only the path and metadata cross the wire.
"""

from __future__ import annotations

import io
import os
import sys
import time
import uuid

from PIL import Image

# observation id -> capture facts; freshness is enforced by both sides.
_OBSERVATIONS: dict[str, dict] = {}


def dhash(image: Image.Image) -> str:
    """64-bit difference hash (16 hex chars): 9x8 grayscale gradient bits."""
    gray = image.convert("L").resize((9, 8), Image.LANCZOS)
    pixels = list(gray.getdata())
    bits = 0
    for row in range(8):
        for col in range(8):
            bits = (bits << 1) | (1 if pixels[row * 9 + col] < pixels[row * 9 + col + 1] else 0)
    return f"{bits:016x}"


def hamming_distance(left: str, right: str) -> int:
    """Bit distance between two 16-hex-char dHash fingerprints."""
    return bin(int(left, 16) ^ int(right, 16)).count("1")


def _prune_expired(ttl_ms: int) -> None:
    now_ms = int(time.time() * 1000)
    expired = [oid for oid, facts in _OBSERVATIONS.items() if now_ms - facts["capturedAtMs"] > ttl_ms]
    for oid in expired:
        _OBSERVATIONS.pop(oid, None)
        # Archived files stay for the audit retention window; Node prunes them.


def capture_screenshot(
    archive_dir: str,
    ttl_ms: int,
    max_width: int | None,
    quality: int,
    region: tuple[int, int, int, int] | None,
    cursor_position: tuple[int, int] | None = None,
    archive_suffix: str = "",
) -> dict:
    """Capture, compress, archive, and register one observation.

    cursor_position draws a synthetic cursor overlay into the final
    (post-resize) image pixel space before encoding — the archived bytes and
    the reported dHash describe the frame WITH the overlay. archive_suffix is
    appended to the archived filename (e.g. "-preview" for click intent
    frames); the caller validates its character set at the wire boundary.
    """
    import pyautogui

    _prune_expired(ttl_ms)
    image = pyautogui.screenshot(region=tuple(region) if region is not None else None)
    if image is None:
        raise RuntimeError(
            "screenshot capture returned nothing"
            + (" (macOS: grant Screen Recording permission)" if sys.platform == "darwin" else "")
        )

    if max_width is not None and image.width > max_width:
        ratio = max_width / image.width
        image = image.resize((max_width, round(image.height * ratio)), Image.LANCZOS)

    # Overlay after the resize: cursor_position is expressed in the encoded
    # image's pixel space, the same basis the caller received the point in.
    if cursor_position is not None:
        from core.cursor_overlay import draw_cursor_overlay

        image = draw_cursor_overlay(image, cursor_position[0], cursor_position[1])

    buffer = io.BytesIO()
    # JPEG has no alpha; drop it before encoding or Pillow errors.
    (image.convert("RGB") if image.mode in ("RGBA", "P", "LA") else image).save(
        buffer, "JPEG", quality=int(quality)
    )
    data = buffer.getvalue()

    observation_id = uuid.uuid4().hex
    path = os.path.join(archive_dir, f"{observation_id}{archive_suffix}.jpg")
    os.makedirs(archive_dir, exist_ok=True)
    with open(path, "wb") as handle:
        handle.write(data)

    facts = {
        "capturedAtMs": int(time.time() * 1000),
        "width": image.width,
        "height": image.height,
        "path": path,
        "dhash": dhash(image),
    }
    _OBSERVATIONS[observation_id] = facts
    result = {
        "observationId": observation_id,
        "path": path,
        "width": image.width,
        "height": image.height,
        "bytes": len(data),
        "dhash": facts["dhash"],
        "capturedAtMs": facts["capturedAtMs"],
    }
    if cursor_position is not None:
        result["cursorOverlay"] = {"x": cursor_position[0], "y": cursor_position[1]}
    return result


def check_observation(observation_id: str, ttl_ms: int) -> dict:
    """Freshness proof for one observation id; raises with a clear reason."""
    facts = _OBSERVATIONS.get(observation_id)
    if facts is None:
        raise ValueError(
            f"unknown ObservationId {observation_id}: capture a screenshot first"
            " (screen_shot) and reference the id it returned"
        )
    age_ms = int(time.time() * 1000) - facts["capturedAtMs"]
    if age_ms > ttl_ms:
        raise ValueError(
            f"ObservationId {observation_id} expired: captured {age_ms} ms ago,"
            f" freshness window is {ttl_ms} ms; capture a fresh screenshot first"
        )
    return facts
