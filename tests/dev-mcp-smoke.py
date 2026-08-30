"""Dev-mode MCP sidecar smoke test.

Spawns `src-python/main.py` over real stdio and walks the protocol:
initialize handshake, tools/list, display enumeration, screenshot capture,
foreground-window query, observation freshness refusal, one live click, and
ping. Run from anywhere: `python tests/dev-mcp-smoke.py`.

This driver is TEST scaffolding — the plugin runtime itself never uses
child_process; it rides ctx.subprocess.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SERVER = ROOT / "src-python" / "main.py"


def main() -> int:
    archive = tempfile.mkdtemp(prefix="dsh-cu-smoke-")
    env = dict(os.environ)
    env["DSH_CU_SCREENSHOT_DIR"] = archive
    env["DSH_CU_OBSERVATION_TTL_MS"] = "30000"
    env["PYTHONIOENCODING"] = "utf-8"

    proc = subprocess.Popen(
        [sys.executable, str(SERVER)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        env=env,
        cwd=str(ROOT / "src-python"),
    )
    assert proc.stdin is not None and proc.stdout is not None

    def send(message: dict) -> None:
        proc.stdin.write(json.dumps(message) + "\n")  # type: ignore[union-attr]
        proc.stdin.flush()  # type: ignore[union-attr]

    def recv() -> dict:
        line = proc.stdout.readline()  # type: ignore[union-attr]
        if not line:
            raise SystemExit(f"sidecar closed stdout; stderr:\n{proc.stderr.read()}")  # type: ignore[union-attr]
        return json.loads(line)

    failures: list[str] = []

    def check(label: str, ok: bool, detail: object = "") -> None:
        print(f"{'ok ' if ok else 'FAIL'} {label}" + ("" if ok else f" — {detail}"))
        if not ok:
            failures.append(label)

    send({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
        "protocolVersion": "2025-03-26", "capabilities": {},
        "clientInfo": {"name": "dsh-cu-smoke", "version": "0.0.0"},
    }})
    init = recv()
    info = init.get("result", {}).get("serverInfo", {})
    check("initialize handshake", info.get("name") == "dsh-cu-server" and str(info.get("version", "")).startswith("0.1."), init)

    send({"jsonrpc": "2.0", "method": "notifications/initialized"})

    send({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
    tools = recv()
    names = {tool["name"] for tool in tools.get("result", {}).get("tools", [])}
    expected = {"get_display_info", "screen_shot", "click_at", "type_text", "scroll", "hotkey", "get_foreground_window"}
    check("tools/list surface", expected <= names, names)

    send({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "get_display_info", "arguments": {}}})
    displays = recv()
    display_list = displays.get("result", {}).get("structuredContent", {}).get("displays", [])
    check("get_display_info", len(display_list) > 0 and all("scaleFactor" in d for d in display_list), displays)
    print("     displays:", json.dumps(display_list, ensure_ascii=False))

    send({"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {
        "name": "screen_shot", "arguments": {"maxWidth": 1280, "quality": 75},
    }})
    shot = recv()
    content = shot.get("result", {}).get("structuredContent", {})
    check("screen_shot", content.get("observationId") is not None and Path(content.get("path", "")).is_file(), shot)
    check("screen_shot dhash", isinstance(content.get("dhash"), str) and len(content.get("dhash", "")) == 16, content.get("dhash"))
    print(f"     {content.get('width')}x{content.get('height')} {content.get('bytes')}B -> {content.get('path')}")
    oid = content.get("observationId", "")
    width = content.get("width", 1280)
    height = content.get("height", 800)

    send({"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "get_foreground_window", "arguments": {}}})
    foreground = recv()
    check("get_foreground_window", "name" in foreground.get("result", {}).get("structuredContent", {}), foreground)
    print("     foreground:", foreground.get("result", {}).get("structuredContent", {}).get("name"))

    # Freshness refusal: unknown observation id must fail with a clear message.
    send({"jsonrpc": "2.0", "id": 6, "method": "tools/call", "params": {"name": "click_at", "arguments": {
        "x": 10, "y": 10, "screenshotWidth": width, "screenshotHeight": height,
        "basedOnObservationId": "0" * 32,
    }}})
    stale = recv()
    stale_result = stale.get("result", {})
    check("unknown ObservationId refused", stale_result.get("isError") is True, stale)
    print("     refusal:", stale_result.get("content", [{}])[0].get("text", "")[:120])

    # Live click at the screenshot center with a valid observation.
    send({"jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": {"name": "click_at", "arguments": {
        "x": width / 2, "y": height / 2, "screenshotWidth": width, "screenshotHeight": height,
        "basedOnObservationId": oid,
    }}})
    click = recv()
    click_content = click.get("result", {}).get("structuredContent", {})
    check("click_at (center)", click_content.get("success") is True, click)
    print(f"     physical=({click_content.get('physicalX')}, {click_content.get('physicalY')}) display={click_content.get('displayId')}")

    send({"jsonrpc": "2.0", "id": 8, "method": "ping"})
    ping = recv()
    check("ping", ping.get("result") == {}, ping)

    proc.stdin.close()  # type: ignore[union-attr]
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()
        failures.append("clean exit")
    stderr_tail = proc.stderr.read()[-400:] if proc.stderr else ""  # type: ignore[union-attr]
    print(f"sidecar exit={proc.returncode}; stderr tail: {stderr_tail.strip()[:200]}")
    check("clean exit", proc.returncode == 0, proc.returncode)

    print(f"\n{'ALL SMOKE CHECKS PASSED' if not failures else 'FAILURES: ' + ', '.join(failures)}")
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
