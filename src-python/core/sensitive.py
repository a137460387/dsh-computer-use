"""Sensitive-window capture refusal.

Screenshots of windows whose title matches a deployment sensitive pattern
(password managers, online banking, ...) are refused BEFORE any capture,
archival, or model transmission: the foreground window title is checked
first, and a hit returns a marker-prefixed error instead of pixels. The
window title may be logged for audit; the screen content never is.

Matching is case-insensitive regex SEARCH (substring semantics). The
allowlist wins over the blocklist, so a deployment can carve out specific
titles. OCR-level sensitive-FIELD detection (password boxes inside ordinary
windows) is not implemented — see Known Limitations.
"""

from __future__ import annotations

import json
import re

SENSITIVE_WINDOW_MARKER = "[dsh-cu-sensitive-window]"


class SensitiveWindowError(RuntimeError):
    """Raised instead of capturing when the foreground window is sensitive.

    The message is the marker plus a JSON facts payload
    (``{"windowTitle": ..., "pattern": ...}``) so the Node side can parse it
    and build the user-facing guidance and the audit record.
    """

    def __init__(self, title: str, pattern: str) -> None:
        self.title = title
        self.pattern = pattern
        super().__init__(
            f"{SENSITIVE_WINDOW_MARKER} "
            + json.dumps({"windowTitle": title, "pattern": pattern}, ensure_ascii=False)
        )


class SensitiveWindowPolicy:
    """Compiled sensitive-window blocklist with a take-priority allowlist."""

    def __init__(self, patterns: list[str], allowlist: list[str]) -> None:
        self._blocked: list[tuple[str, re.Pattern[str]]] = []
        for source in patterns:
            if not source:
                raise ValueError("sensitive window pattern must not be empty")
            self._blocked.append((source, re.compile(source, re.IGNORECASE)))
        self._allowed: list[re.Pattern[str]] = []
        for source in allowlist:
            if not source:
                raise ValueError("sensitive window allowlist entry must not be empty")
            self._allowed.append(re.compile(source, re.IGNORECASE))

    def match_blocked(self, title: str) -> str | None:
        """The blocking pattern source for this title, or None when allowed."""
        if any(regex.search(title) for regex in self._allowed):
            return None
        for source, regex in self._blocked:
            if regex.search(title):
                return source
        return None
