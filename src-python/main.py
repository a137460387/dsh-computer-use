"""dsh-cu-server: the desktop-control MCP sidecar (stdio, JSON-RPC 2.0).

Standard MCP stdio transport: one JSON-RPC message per stdin line, replies on
stdout, diagnostics on stderr (stdout carries protocol bytes ONLY). The Node
plugin spawns this process through ctx.subprocess and talks MCP to it.

Configuration arrives through explicit spawn environment entries (the Node
side layers them over the scrubbed parent environment):

- DSH_CU_SCREENSHOT_DIR      archive directory for captured frames (required)
- DSH_CU_OBSERVATION_TTL_MS  observation freshness window in ms (default 30000)
"""

from __future__ import annotations

import json
import os
import sys
import time

VERSION = "0.1.0"
SERVER_NAME = "dsh-cu-server"

# Protocol versions this server negotiates; the client's is echoed when known.
KNOWN_PROTOCOL_VERSIONS = ("2024-11-05", "2025-03-26", "2025-06-18")

_LOG_PREFIX = f"[{SERVER_NAME}]"


def _log(message: str) -> None:
    print(f"{_LOG_PREFIX} {message}", file=sys.stderr, flush=True)


def _config() -> dict:
    archive_dir = os.environ.get("DSH_CU_SCREENSHOT_DIR", "")
    if not archive_dir:
        raise SystemExit(f"{_LOG_PREFIX} DSH_CU_SCREENSHOT_DIR is required (Node spawn contract)")
    ttl = int(os.environ.get("DSH_CU_OBSERVATION_TTL_MS", "30000"))
    return {"archive_dir": archive_dir, "ttl_ms": ttl}


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
]


# ── tool dispatch ────────────────────────────────────────────────────────────


def _dispatch_tool(name: str, arguments: dict, config: dict) -> dict:
    """Execute one tool; returns structuredContent for the MCP result."""
    from core import display, input as input_core, screen
    from utils import danger_regex

    if name == "get_display_info":
        display.enable_dpi_awareness()
        displays = display.get_displays()
        return {"displays": [d.as_dict() for d in displays]}

    if name == "screen_shot":
        region = arguments.get("region")
        return screen.capture_screenshot(
            archive_dir=config["archive_dir"],
            ttl_ms=config["ttl_ms"],
            max_width=arguments.get("maxWidth"),
            quality=int(arguments.get("quality", 75)),
            region=None if region is None else (region["x"], region["y"], region["width"], region["height"]),
        )

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
        input_core.click(px, py)
        return {"success": True, "physicalX": px, "physicalY": py, "displayId": target.id}

    if name == "type_text":
        text = str(arguments["text"])
        danger = danger_regex.find_danger(text)
        if danger is not None:
            raise ValueError(f"type_text blocked by the sidecar danger backstop (pattern {danger!r})")
        input_core.type_text(text)
        return {"success": True, "chars": len(text)}

    if name == "scroll":
        input_core.scroll(str(arguments["direction"]), int(arguments["amount"]))
        return {"success": True}

    if name == "hotkey":
        keys = [str(key) for key in arguments["keys"]]
        if not keys:
            raise ValueError("hotkey needs at least one key")
        input_core.hotkey(keys)
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
    config = _config()
    if sys.platform == "win32":
        from core import display

        try:
            display.assert_interactive_session()
        except RuntimeError as error:
            raise SystemExit(f"{_LOG_PREFIX} refusing to start: {error}")
    _log(f"starting v{VERSION}; archive={config['archive_dir']} ttl={config['ttl_ms']}ms")
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except json.JSONDecodeError as error:
            sys.stdout.write(json.dumps({
                "jsonrpc": "2.0",
                "id": None,
                "error": {"code": -32700, "message": f"parse error: {error}"},
            }) + "\n")
            sys.stdout.flush()
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
            sys.stdout.write(json.dumps(response) + "\n")
            sys.stdout.flush()
    _log("stdin closed; exiting")


if __name__ == "__main__":
    main()
