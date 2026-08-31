"""Unit tests for the sidecar pause state machine, the takeover-monitor
detection unit, and the sensitive-window policy.

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

from core.pause import (  # noqa: E402
    PAUSED_MARKER,
    MonitorState,
    PausedError,
    PauseState,
    resolve_hotkey_vks,
)
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


class FakeClock:
    """Injected monotonic clock so detection tests never sleep."""

    def __init__(self) -> None:
        self.now = 0.0

    def advance(self, seconds: float) -> None:
        self.now += seconds

    def __call__(self) -> float:
        return self.now


def _feed(monitor: MonitorState, **overrides) -> str | None:
    """One poll with quiet defaults; tests override only what they exercise."""
    args = dict(
        combo_down=False,
        key_down=False,
        cursor=None,
        pause_on_user_input=True,
        paused=False,
        suppressed=False,
    )
    args.update(overrides)
    return monitor.feed(**args)


class MonitorStateStartupGrace(unittest.TestCase):
    """D2 regressions: the startup window discards every detection."""

    def test_stale_key_latch_inside_the_grace_does_not_pause(self) -> None:
        clock = FakeClock()
        monitor = MonitorState(startup_grace_ms=500, clock=clock)
        monitor.arm(cursor=(100, 100))
        clock.advance(0.05)
        # A key latched right after arming (predating any real user input).
        self.assertIsNone(_feed(monitor, key_down=True))
        clock.advance(0.5)
        # Nothing carried over once the window closed.
        self.assertIsNone(_feed(monitor))

    def test_cursor_and_key_activity_inside_the_grace_is_discarded(self) -> None:
        clock = FakeClock()
        monitor = MonitorState(startup_grace_ms=500, clock=clock)
        monitor.arm(cursor=(100, 100))
        clock.advance(0.2)
        self.assertIsNone(_feed(monitor, cursor=(300, 300), key_down=True))
        clock.advance(0.2)  # still inside the window
        self.assertIsNone(_feed(monitor, cursor=(301, 301)))

    def test_cursor_baseline_refreshes_during_the_grace(self) -> None:
        clock = FakeClock()
        monitor = MonitorState(startup_grace_ms=500, clock=clock)
        monitor.arm(cursor=(100, 100))
        clock.advance(0.3)
        self.assertIsNone(_feed(monitor, cursor=(900, 900)))  # move inside grace
        clock.advance(0.3)  # window closed
        self.assertIsNone(_feed(monitor, cursor=(900, 900)))  # still → no fire
        self.assertEqual(_feed(monitor, cursor=(901, 900)), "user-input")

    def test_combo_held_across_the_grace_does_not_toggle_on_exit(self) -> None:
        clock = FakeClock()
        monitor = MonitorState(startup_grace_ms=500, clock=clock)
        monitor.arm(cursor=None)
        clock.advance(0.1)
        self.assertIsNone(_feed(monitor, combo_down=True))  # discarded in grace
        clock.advance(0.5)
        self.assertIsNone(_feed(monitor, combo_down=True))  # edge tracked, no toggle
        self.assertIsNone(_feed(monitor, combo_down=False))
        self.assertEqual(_feed(monitor, combo_down=True), "hotkey")


class MonitorStateDecisions(unittest.TestCase):
    """Post-grace semantics: user input pauses, exemptions hold, hotkey toggles."""

    def armed(self, grace_ms: int = 0) -> tuple[MonitorState, FakeClock]:
        clock = FakeClock()
        monitor = MonitorState(startup_grace_ms=grace_ms, clock=clock)
        monitor.arm(cursor=(100, 100))
        clock.advance(0.05)  # past any startup grace under test
        return monitor, clock

    def test_movement_after_the_grace_detects_user_input(self) -> None:
        monitor, _ = self.armed()
        self.assertIsNone(_feed(monitor, cursor=(100, 100)))  # cursor still
        self.assertEqual(_feed(monitor, cursor=(120, 100)), "user-input")

    def test_keypress_after_the_grace_detects_user_input(self) -> None:
        monitor, _ = self.armed()
        self.assertEqual(_feed(monitor, cursor=(100, 100), key_down=True), "user-input")

    def test_suppressed_window_blocks_user_input_detection(self) -> None:
        monitor, _ = self.armed()
        self.assertIsNone(_feed(monitor, key_down=True, suppressed=True))
        self.assertIsNone(_feed(monitor, cursor=(150, 150), suppressed=True))
        self.assertEqual(_feed(monitor, key_down=True), "user-input")

    def test_paused_blocks_user_input_but_hotkey_still_toggles(self) -> None:
        monitor, _ = self.armed()
        self.assertIsNone(_feed(monitor, key_down=True, paused=True))
        self.assertEqual(_feed(monitor, combo_down=True, paused=True), "hotkey")

    def test_disabled_user_input_pause_detects_nothing_but_hotkey(self) -> None:
        monitor, _ = self.armed()
        self.assertIsNone(_feed(monitor, key_down=True, pause_on_user_input=False))
        self.assertEqual(_feed(monitor, combo_down=True, pause_on_user_input=False), "hotkey")

    def test_hotkey_detection_is_edge_triggered(self) -> None:
        monitor, _ = self.armed()
        self.assertEqual(_feed(monitor, combo_down=True), "hotkey")
        self.assertIsNone(_feed(monitor, combo_down=True))  # still held
        self.assertIsNone(_feed(monitor, combo_down=False))  # released
        self.assertEqual(_feed(monitor, combo_down=True), "hotkey")  # pressed again

    def test_missing_cursor_position_keeps_the_baseline(self) -> None:
        clock = FakeClock()
        monitor = MonitorState(startup_grace_ms=0, clock=clock)
        monitor.arm(cursor=None)
        clock.advance(0.05)
        self.assertIsNone(_feed(monitor, cursor=None))
        self.assertIsNone(_feed(monitor, cursor=(50, 50)))  # first fix is the baseline
        self.assertEqual(_feed(monitor, cursor=(60, 50)), "user-input")

    def test_feed_before_arming_detects_nothing(self) -> None:
        monitor = MonitorState(startup_grace_ms=0, clock=FakeClock())
        self.assertIsNone(_feed(monitor, key_down=True, cursor=(1, 1)))


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
