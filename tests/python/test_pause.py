"""Unit tests for the sidecar pause state machine and sensitive-window policy.

Pure-Python surfaces only (no ctypes calls), so they run on every platform:

    python -m unittest discover -s tests/python -v
"""

from __future__ import annotations

import json
import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src-python"))

from core.pause import PAUSED_MARKER, PausedError, PauseState, resolve_hotkey_vks  # noqa: E402
from core.sensitive import (  # noqa: E402
    SENSITIVE_WINDOW_MARKER,
    SensitiveWindowError,
    SensitiveWindowPolicy,
)


class PauseStateTransitions(unittest.TestCase):
    def test_starts_running(self) -> None:
        state = PauseState()
        self.assertFalse(state.paused)
        state.assert_running()  # must not raise

    def test_pause_then_resume_with_reasons(self) -> None:
        transitions: list[tuple[bool, str]] = []
        state = PauseState(on_transition=lambda paused, reason: transitions.append((paused, reason)))

        self.assertTrue(state.pause("hotkey"))
        self.assertTrue(state.paused)
        self.assertFalse(state.pause("user-input"))  # idempotent while paused
        self.assertEqual(transitions, [(True, "hotkey")])

        with self.assertRaises(PausedError):
            state.assert_running()

        self.assertTrue(state.resume("manual"))
        self.assertFalse(state.paused)
        self.assertFalse(state.resume("manual"))  # idempotent while running
        self.assertEqual(transitions, [(True, "hotkey"), (False, "manual")])
        state.assert_running()  # must not raise again

    def test_paused_error_carries_the_marker_and_resume_hint(self) -> None:
        error = PausedError()
        self.assertIn(PAUSED_MARKER, str(error))
        self.assertIn("resume_actions", str(error))


class PauseStateInFlight(unittest.TestCase):
    def test_input_suppressed_inside_the_in_flight_window(self) -> None:
        state = PauseState()
        self.assertFalse(state.input_suppressed(grace_ms=0))
        state.begin_action()
        self.assertTrue(state.input_suppressed(grace_ms=0))
        state.end_action()

    def test_grace_window_after_the_last_action_ends(self) -> None:
        state = PauseState()
        state.begin_action()
        state.end_action()
        self.assertTrue(state.input_suppressed(grace_ms=10_000))
        self.assertFalse(state.input_suppressed(grace_ms=0))

    def test_grace_expires_with_time(self) -> None:
        state = PauseState()
        state.begin_action()
        state.end_action()
        time.sleep(0.08)
        self.assertFalse(state.input_suppressed(grace_ms=50))

    def test_nested_actions_only_clear_on_the_last_end(self) -> None:
        state = PauseState()
        state.begin_action()
        state.begin_action()
        state.end_action()
        self.assertTrue(state.input_suppressed(grace_ms=0))  # still in flight
        state.end_action()
        self.assertFalse(state.input_suppressed(grace_ms=0))

    def test_end_action_never_drives_the_counter_negative(self) -> None:
        state = PauseState()
        state.end_action()
        self.assertFalse(state.input_suppressed(grace_ms=10_000))


class ResolveHotkeyVks(unittest.TestCase):
    def test_resolves_the_default_combo(self) -> None:
        self.assertEqual(resolve_hotkey_vks(["ctrl", "alt", "u"]), [0x11, 0x12, 0x55])

    def test_is_case_insensitive(self) -> None:
        self.assertEqual(resolve_hotkey_vks(["CTRL", "Alt", "U"]), [0x11, 0x12, 0x55])

    def test_resolves_digits_and_function_keys(self) -> None:
        self.assertEqual(resolve_hotkey_vks(["9", "f12"]), [0x39, 0x7B])

    def test_unknown_key_names_fail_loud(self) -> None:
        with self.assertRaisesRegex(ValueError, "unknown key name 'hyper'"):
            resolve_hotkey_vks(["ctrl", "hyper"])

    def test_empty_combo_disables_detection(self) -> None:
        self.assertEqual(resolve_hotkey_vks([]), [])


class SensitiveWindowPolicyMatching(unittest.TestCase):
    def test_blocks_case_insensitively_by_substring(self) -> None:
        policy = SensitiveWindowPolicy(["keepass"], [])
        self.assertEqual(policy.match_blocked("KeePass 2 — MyPasswords.kdbx"), "keepass")

    def test_blocks_chinese_titles(self) -> None:
        policy = SensitiveWindowPolicy(["网银", "密码管理器"], [])
        self.assertEqual(policy.match_blocked("工商银行个人网银"), "网银")
        self.assertIsNone(policy.match_blocked("普通记事本"))

    def test_allowlist_wins_over_the_blocklist(self) -> None:
        policy = SensitiveWindowPolicy(["1password"], ["1password setup guide"])
        self.assertIsNone(policy.match_blocked("1Password setup guide — browser"))
        self.assertEqual(policy.match_blocked("1Password — vault"), "1password")

    def test_no_match_returns_none(self) -> None:
        policy = SensitiveWindowPolicy(["keepass"], [])
        self.assertIsNone(policy.match_blocked("Visual Studio Code"))

    def test_empty_entries_fail_loud(self) -> None:
        with self.assertRaisesRegex(ValueError, "pattern must not be empty"):
            SensitiveWindowPolicy([""], [])
        with self.assertRaisesRegex(ValueError, "allowlist entry must not be empty"):
            SensitiveWindowPolicy([], [""])

    def test_error_message_carries_marker_and_json_facts(self) -> None:
        error = SensitiveWindowError("KeePass 2", "keepass")
        text = str(error)
        self.assertTrue(text.startswith(SENSITIVE_WINDOW_MARKER))
        facts = json.loads(text.removeprefix(SENSITIVE_WINDOW_MARKER).strip())
        self.assertEqual(facts, {"windowTitle": "KeePass 2", "pattern": "keepass"})


if __name__ == "__main__":
    unittest.main()
