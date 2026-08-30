"""Dangerous-content patterns for typed text.

This is the sidecar-side backstop of the danger filter; the Node plugin
(`src/security/danger-filter.ts`) is the primary gate and blocks before the
request ever crosses the wire. Neither layer is a reliable security boundary
— both are mis-fire protection. Keep the two pattern sets aligned.
"""

from __future__ import annotations

import re

DANGER_PATTERNS: tuple[str, ...] = (
    # rm -rf / rm -fr variants and recursive rm
    r"\brm\s+-(?:[a-z]*r[a-z]*f|[a-z]*f[a-z]*r)[a-z]*\b",
    r"\brm\s+--recursive\b",
    # Windows destructive file commands
    r"\bdel\s+/[a-z]*f\b",
    r"\brmdir\s+/s\b",
    r"\bformat\s+[a-z]:",
    r"Remove-Item\b.*-Recurse",
    r"Format-Volume",
    # privilege escalation and power control
    r"\bsudo\b",
    r"\bshutdown\b",
    r"\breboot\b",
    # disk destruction
    r"\bmkfs\b",
    r"\bdd\b.*\bof=/dev/",
)

_COMPILED = tuple(re.compile(pattern, re.IGNORECASE) for pattern in DANGER_PATTERNS)


def find_danger(text: str) -> str | None:
    """The first danger pattern matching `text`, or None when clean."""
    for pattern in _COMPILED:
        if pattern.search(text) is not None:
            return pattern.pattern
    return None
