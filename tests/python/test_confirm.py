"""Unit tests for the confirm-gate sidecar protocol: the pause_actions
reason attribution, the monotonic transition counter on the response, the
arm_danger_token single-slot, and the one-shot danger-token consumption in
type_text.

Pure-Python surfaces only (pyautogui is faked), so they run on every platform:

    python -m unittest discover -s tests/python -v
"""

from __future__ import annotations

import sys
import types
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src-python"))

from core.pause import PauseState  # noqa: E402
from core.sensitive import SensitiveWindowPolicy  # noqa: E402

import main  # noqa: E402


def _fake_pyautogui() -> types.ModuleType:
    """A pyautogui stand-in whose typing/hotkey calls record nothing."""
    fake = types.ModuleType("pyautogui")
    fake.typewrite = lambda text, interval=0: None
    fake.hotkey = lambda *keys: None
    return fake


def _dispatch_config(with_callback: bool = False) -> dict:
    transitions: list[tuple[bool, str, int]] = []
    state = PauseState(
        on_transition=(lambda paused, reason, seq: transitions.append((paused, reason, seq)))
        if with_callback else None,
    )
    return {
        "archive_dir": "unused",
        "ttl_ms": 30_000,
        "monitor": {"hotkey": [], "pause_on_user_input": False, "grace_ms": 0, "startup_grace_ms": 0},
        "sensitive_policy": SensitiveWindowPolicy([], []),
        "pause_state": state,
        "danger_token": None,
        "transitions": transitions,
    }


class VersionSync(unittest.TestCase):
    def test_sidecar_version_stays_on_the_compatible_prefix(self) -> None:
        # The Node plugin accepts 0.1.* (additive growth); the three sync
        # points move together at release time.
        self.assertTrue(main.VERSION.startswith("0.1."), main.VERSION)


class PauseActionsProtocol(unittest.TestCase):
    def test_defaults_to_the_manual_reason_and_reports_the_counter(self) -> None:
        config = _dispatch_config(with_callback=True)
        result = main._dispatch_tool("pause_actions", {}, config)
        self.assertEqual(result, {"success": True, "paused": True, "transitionSeq": 1})
        self.assertEqual(config["transitions"], [(True, "manual", 1)])

    def test_confirm_reason_reaches_the_transition_notification(self) -> None:
        config = _dispatch_config(with_callback=True)
        result = main._dispatch_tool("pause_actions", {"reason": "confirm"}, config)
        self.assertEqual(result, {"success": True, "paused": True, "transitionSeq": 1})
        self.assertEqual(config["transitions"], [(True, "confirm", 1)])

    def test_reasons_outside_manual_and_confirm_are_refused(self) -> None:
        config = _dispatch_config(with_callback=True)
        with self.assertRaisesRegex(ValueError, "'manual' or 'confirm'"):
            main._dispatch_tool("pause_actions", {"reason": "hotkey"}, config)
        self.assertEqual(config["transitions"], [])

    def test_idempotent_pause_reports_the_current_counter_without_transition(self) -> None:
        config = _dispatch_config(with_callback=True)
        main._dispatch_tool("pause_actions", {"reason": "confirm"}, config)
        result = main._dispatch_tool("pause_actions", {"reason": "confirm"}, config)
        # No new transition: the counter still serves as the Node-side ack
        # baseline even when the pause was already held.
        self.assertEqual(result, {"success": True, "paused": False, "transitionSeq": 1})
        self.assertEqual(config["transitions"], [(True, "confirm", 1)])


class ArmDangerTokenProtocol(unittest.TestCase):
    def test_arms_the_single_slot(self) -> None:
        config = _dispatch_config()
        result = main._dispatch_tool("arm_danger_token", {"token": "tok-1"}, config)
        self.assertEqual(result["success"], True)
        self.assertEqual(config["danger_token"], "tok-1")

    def test_a_new_token_replaces_the_previous_one(self) -> None:
        config = _dispatch_config()
        main._dispatch_tool("arm_danger_token", {"token": "tok-1"}, config)
        main._dispatch_tool("arm_danger_token", {"token": "tok-2"}, config)
        self.assertEqual(config["danger_token"], "tok-2")

    def test_missing_or_unusable_tokens_are_refused(self) -> None:
        config = _dispatch_config()
        for arguments in ({}, {"token": ""}, {"token": "x" * 300}, {"token": 12}):
            with self.assertRaises(ValueError):
                main._dispatch_tool("arm_danger_token", dict(arguments), config)
        self.assertIsNone(config["danger_token"])

    def test_arming_works_while_paused(self) -> None:
        config = _dispatch_config()
        main._dispatch_tool("pause_actions", {"reason": "confirm"}, config)
        result = main._dispatch_tool("arm_danger_token", {"token": "tok-1"}, config)
        self.assertEqual(result["success"], True)


class DangerTokenConsumption(unittest.TestCase):
    DANGER_PAYLOAD = "sudo rm -rf /"

    def _type(self, config: dict, **arguments) -> dict:
        with mock.patch.dict(sys.modules, {"pyautogui": _fake_pyautogui()}):
            return main._dispatch_tool("type_text", {"text": self.DANGER_PAYLOAD, **arguments}, config)

    def test_danger_payload_refused_without_a_token(self) -> None:
        config = _dispatch_config()
        with self.assertRaisesRegex(ValueError, "danger backstop"):
            self._type(config)

    def test_matching_token_releases_exactly_one_payload(self) -> None:
        config = _dispatch_config()
        main._dispatch_tool("arm_danger_token", {"token": "tok-1"}, config)

        result = self._type(config, dangerToken="tok-1")
        self.assertEqual(result["success"], True)
        self.assertEqual(result["chars"], len(self.DANGER_PAYLOAD))
        # Single-use: consumed on passage; the next danger payload is refused.
        self.assertIsNone(config["danger_token"])
        with self.assertRaisesRegex(ValueError, "danger backstop"):
            self._type(config, dangerToken="tok-1")

    def test_mismatched_token_keeps_the_slot_armed_and_refuses(self) -> None:
        config = _dispatch_config()
        main._dispatch_tool("arm_danger_token", {"token": "tok-1"}, config)

        with self.assertRaisesRegex(ValueError, "danger backstop"):
            self._type(config, dangerToken="tok-2")
        self.assertEqual(config["danger_token"], "tok-1")

    def test_clean_payload_does_not_consume_the_token(self) -> None:
        config = _dispatch_config()
        main._dispatch_tool("arm_danger_token", {"token": "tok-1"}, config)

        with mock.patch.dict(sys.modules, {"pyautogui": _fake_pyautogui()}):
            result = main._dispatch_tool("type_text", {"text": "hello", "dangerToken": "tok-1"}, config)
        self.assertEqual(result["success"], True)
        self.assertEqual(config["danger_token"], "tok-1")


if __name__ == "__main__":
    unittest.main()
