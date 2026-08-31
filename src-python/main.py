"""dsh-cu-server: the desktop-control MCP sidecar (stdio, JSON-RPC 2.0).

Standard MCP stdio transport: one JSON-RPC message per stdin line, replies on
stdout, diagnostics on stderr (stdout carries protocol bytes ONLY). The Node
plugin spawns this process through ctx.subprocess and talks MCP to it.

Configuration arrives through explicit spawn environment entries (the Node
side layers them over the scrubbed parent environment):

- DSH_CU_SCREENSHOT_DIR            archive directory for captured frames (required)
- DSH_CU_OBSERVATION_TTL_MS        observation freshness window in ms (default 30000)
- DSH_CU_TAKEOVER_HOTKEY           canonical hotkey, '+'-joined (default ctrl+alt+u; empty disables)
- DSH_CU_PAUSE_ON_USER_INPUT       "1"/"0" user-input pause (default 1)
- DSH_CU_USER_INPUT_GRACE_MS       post-action detection grace in ms (default 250)
- DSH_CU_MONITOR_STARTUP_GRACE_MS  startup detection grace in ms (default 500)
- DSH_CU_SENSITIVE_WINDOW_PATTERNS JSON array of title regexes refusing capture
- DSH_CU_SENSITIVE_WINDOW_ALLOWLIST JSON array of title regexes beating the blocklist

Pause state: a background monitor toggles pause on the takeover hotkey and
pauses on user input outside the agent-action in-flight window. While paused
the four action tools refuse with a `[dsh-cu-paused]` marker; every
transition is pushed to the Node plugin as a `notifications/dsh-cu/pause-state`
JSON-RPC notification (written under the stdout lock shared with responses).
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time

# Sync point: keep aligned with the Node side's package.json "version" and
# the MCP client identity version in src/provider-mcp/index.ts.
VERSION = "0.1.1"
SERVER_NAME = "dsh-cu-server"

# Protocol versions this server negotiates; the client's is echoed when known.
KNOWN_PROTOCOL_VERSIONS = ("2024-11-05", "2025-03-26", "2025-06-18")

_LOG_PREFIX = f"[{SERVER_NAME}]"

# One lock for every stdout write: responses come from the stdin loop while
# pause transitions are pushed from the monitor thread.
_stdout_lock = threading.Lock()


def _log(message: str) -> None:
    print(f"{_LOG_PREFIX} {message}", file=sys.stderr, flush=True)


def _write(message: dict) -> None:
    with _stdout_lock:
        sys.stdout.write(json.dumps(message, ensure_ascii=False) + "\n")
        sys.stdout.flush()


def _config() -> dict:
    from core.sensitive import SensitiveWindowPolicy

    archive_dir = os.environ.get("DSH_CU_SCREENSHOT_DIR", "")
    if not archive_dir:
        raise SystemExit(f"{_LOG_PREFIX} DSH_CU_SCREENSHOT_DIR is required (Node spawn contract)")
    ttl = int(os.environ.get("DSH_CU_OBSERVATION_TTL_MS", "30000"))

    hotkey = [part for part in os.environ.get("DSH_CU_TAKEOVER_HOTKEY", "").split("+") if part]
    monitor = {
        "hotkey": hotkey,
        "pause_on_user_input": os.environ.get("DSH_CU_PAUSE_ON_USER_INPUT", "1") == "1",
        "grace_ms": int(os.environ.get("DSH_CU_USER_INPUT_GRACE_MS", "250")),
        "startup_grace_ms": int(os.environ.get("DSH_CU_MONITOR_STARTUP_GRACE_MS", "500")),
    }

    try:
        patterns = json.loads(os.environ.get("DSH_CU_SENSITIVE_WINDOW_PATTERNS", "[]"))
        allowlist = json.loads(os.environ.get("DSH_CU_SENSITIVE_WINDOW_ALLOWLIST", "[]"))
    except json.JSONDecodeError as error:
        raise SystemExit(f"{_LOG_PREFIX} invalid sensitive-window env JSON: {error}")
    try:
        sensitive_policy = SensitiveWindowPolicy(list(patterns), list(allowlist))
    except ValueError as error:
        raise SystemExit(f"{_LOG_PREFIX} invalid sensitive-window config: {error}")

    return {
        "archive_dir": archive_dir,
        "ttl_ms": ttl,
        "monitor": monitor,
        "sensitive_policy": sensitive_policy,
    }


# ── MCP tool schemas ─────────────────────────────────────────────────────────

_TOOL_SCHEMAS: list[dict] = [
    {
        "name": "get_display_info",
        "description": "Every attached display with physical bounds and per-display scale factor.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "screen_shot",
        "description": "Capture a JPEG screenshot observation; returns path, dimensions, dHash, and the ObservationId.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "maxWidth": {"type": "integer", "description": "Width ceiling in pixels."},
                "quality": {"type": "integer", "description": "JPEG quality 1-100."},
                "region": {
                    "type": "object",
                    "properties": {
                        "x": {"type": "integer"},
                        "y": {"type": "integer"},
                        "width": {"type": "integer"},
                        "height": {"type": "integer"},
                    },
                    "required": ["x", "y", "width", "height"],
                    "additionalProperties": False,
                },
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "click_at",
        "description": "Click one screenshot-space point; the sidecar maps it per-display with DPI awareness.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "x": {"type": "number"},
                "y": {"type": "number"},
                "screenshotWidth": {"type": "integer"},
                "screenshotHeight": {"type": "integer"},
                "basedOnObservationId": {"type": "string"},
            },
            "required": ["x", "y", "screenshotWidth", "screenshotHeight"],
            "additionalProperties": False,
        },
    },
    {
        "name": "type_text",
        "description": "Type text into the focused window.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "text": {"type": "string"},
                "basedOnObservationId": {"type": "string"},
            },
            "required": ["text"],
            "additionalProperties": False,
        },
    },
    {
        "name": "scroll",
        "description": "Scroll the focused surface by wheel notches.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "direction": {"type": "string", "enum": ["up", "down", "left", "right"]},
                "amount": {"type": "integer"},
                "basedOnObservationId": {"type": "string"},
            },
            "required": ["direction", "amount"],
            "additionalProperties": False,
        },
    },
    {
        "name": "hotkey",
        "description": "Press one key combination.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "keys": {"type": "array", "items": {"type": "string"}},
                "basedOnObservationId": {"type": "string"},
            },
            "required": ["keys"],
            "additionalProperties": False,
        },
    },
    {
        "name": "get_foreground_window",
        "description": "Basename of the process owning the foreground window.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "resume_actions",
        "description": "Resume desktop control actions after a pause (takeover hotkey or user input).",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "pause_actions",
        "description": "Pause desktop control actions until resumed.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
]


# ── tool dispatch ────────────────────────────────────────────────────────────


def _dispatch_tool(name: str, arguments: dict, config: dict) -> dict:
    """Execute one tool; returns structuredContent for the MCP result."""
    from core import display, input as input_core, screen
    from utils import danger_regex

    pause_state = config["pause_state"]

    if name == "get_display_info":
        display.enable_dpi_awareness()
        displays = display.get_displays()
        return {"displays": [d.as_dict() for d in displays]}

    if name == "screen_shot":
        # Sensitive-window refusal precedes ANY capture, archival, or model
        # transmission: the title check runs before a single pixel is grabbed.
        title = input_core.foreground_window_title()
        if title is not None:
            blocked = config["sensitive_policy"].match_blocked(title)
            if blocked is not None:
                from core.sensitive import SensitiveWindowError

                raise SensitiveWindowError(title, blocked)
        region = arguments.get("region")
        return screen.capture_screenshot(
            archive_dir=config["archive_dir"],
            ttl_ms=config["ttl_ms"],
            max_width=arguments.get("maxWidth"),
            quality=int(arguments.get("quality", 75)),
            region=None if region is None else (region["x"], region["y"], region["width"], region["height"]),
        )

    if name == "resume_actions":
        resumed = pause_state.resume("manual")
        return {"success": True, "resumed": resumed}

    if name == "pause_actions":
        paused = pause_state.pause("manual")
        return {"success": True, "paused": paused}

    # The four mutating tools below refuse while paused and run inside the
    # in-flight window so the monitor never mistakes sidecar input for the user.
    pause_state.assert_running()

    observation_id = arguments.get("basedOnObservationId")
    if observation_id is not None:
        screen.check_observation(str(observation_id), config["ttl_ms"])

    if name == "click_at":
        displays = display.get_displays()
        px, py, target = display.screenshot_point_to_physical(
            float(arguments["x"]),
            float(arguments["y"]),
            int(arguments["screenshotWidth"]),
            int(arguments["screenshotHeight"]),
            displays,
        )
        pause_state.begin_action()
        try:
            input_core.click(px, py)
        finally:
            pause_state.end_action()
        return {"success": True, "physicalX": px, "physicalY": py, "displayId": target.id}

    if name == "type_text":
        text = str(arguments["text"])
        danger = danger_regex.find_danger(text)
        if danger is not None:
            raise ValueError(f"type_text blocked by the sidecar danger backstop (pattern {danger!r})")
        pause_state.begin_action()
        try:
            input_core.type_text(text)
        finally:
            pause_state.end_action()
        return {"success": True, "chars": len(text)}

    if name == "scroll":
        pause_state.begin_action()
        try:
            input_core.scroll(str(arguments["direction"]), int(arguments["amount"]))
        finally:
            pause_state.end_action()
        return {"success": True}

    if name == "hotkey":
        keys = [str(key) for key in arguments["keys"]]
        if not keys:
            raise ValueError("hotkey needs at least one key")
        pause_state.begin_action()
        try:
            input_core.hotkey(keys)
        finally:
            pause_state.end_action()
        return {"success": True, "keys": keys}

    if name == "get_foreground_window":
        return {"name": input_core.foreground_process_name()}

    raise ValueError(f"unknown tool {name!r}")


# ── JSON-RPC loop ────────────────────────────────────────────────────────────


def _handle(message: dict, config: dict) -> dict | None:
    """One inbound message; a JSON-RPC response dict, or None for notifications."""
    method = message.get("method")
    message_id = message.get("id")
    params = message.get("params") or {}

    if method == "initialize":
        requested = params.get("protocolVersion", "")
        version = requested if requested in KNOWN_PROTOCOL_VERSIONS else KNOWN_PROTOCOL_VERSIONS[0]
        return _result(message_id, {
            "protocolVersion": version,
            "capabilities": {"tools": {}},
            "serverInfo": {"name": SERVER_NAME, "version": VERSION},
        })

    if method == "notifications/initialized":
        return None

    if method == "ping":
        return _result(message_id, {})

    if method == "tools/list":
        return _result(message_id, {"tools": _TOOL_SCHEMAS})

    if method == "tools/call":
        tool_name = str(params.get("name", ""))
        arguments = params.get("arguments") or {}
        started = time.monotonic()
        try:
            structured = _dispatch_tool(tool_name, dict(arguments), config)
            # Sidecar-side execution time rides every action result (the Node
            # ActionResult contract requires it).
            if isinstance(structured, dict) and "durationMs" not in structured:
                structured["durationMs"] = round((time.monotonic() - started) * 1000)
            return _result(message_id, {
                "content": [{"type": "text", "text": json.dumps(structured)}],
                "structuredContent": structured,
                "isError": False,
            })
        except Exception as error:  # tool execution failures surface as MCP isError results
            _log(f"tool {tool_name} failed: {error}")
            return _result(message_id, {
                "content": [{"type": "text", "text": str(error)}],
                "isError": True,
            })

    if message_id is None:
        _log(f"ignoring unknown notification {method!r}")
        return None
    return {
        "jsonrpc": "2.0",
        "id": message_id,
        "error": {"code": -32601, "message": f"method not found: {method}"},
    }


def _result(message_id, result: dict) -> dict:
    return {"jsonrpc": "2.0", "id": message_id, "result": result}


def main() -> None:
    from core.pause import PauseState, start_monitor

    config = _config()
    if sys.platform == "win32":
        from core import display

        try:
            display.assert_interactive_session()
        except RuntimeError as error:
            raise SystemExit(f"{_LOG_PREFIX} refusing to start: {error}")

    config["pause_state"] = PauseState(on_transition=lambda paused, reason: _write({
        "jsonrpc": "2.0",
        "method": "notifications/dsh-cu/pause-state",
        "params": {"paused": paused, "reason": reason},
    }))
    start_monitor(config["pause_state"], config["monitor"])

    monitor = config["monitor"]
    _log(
        f"starting v{VERSION}; archive={config['archive_dir']} ttl={config['ttl_ms']}ms "
        f"takeover-hotkey={'+'.join(monitor['hotkey']) or 'disabled'} "
        f"user-input-pause={'on' if monitor['pause_on_user_input'] else 'off'}"
    )
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except json.JSONDecodeError as error:
            _write({
                "jsonrpc": "2.0",
                "id": None,
                "error": {"code": -32700, "message": f"parse error: {error}"},
            })
            continue
        try:
            response = _handle(message, config)
        except Exception as error:  # protocol-level failures keep the server alive
            _log(f"handler failure: {error}")
            response = {
                "jsonrpc": "2.0",
                "id": message.get("id"),
                "error": {"code": -32603, "message": str(error)},
            }
        if response is not None:
            _write(response)
    _log("stdin closed; exiting")


if __name__ == "__main__":
    main()
