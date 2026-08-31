"""Build the production sidecar binary with PyInstaller.

Packages src-python/main.py into a single-file executable under bin/, named
after the platform tag the Node provider resolves (dsh-cu-server-win-x64.exe
on Windows, dsh-cu-server-macos-<arch> on macOS), and prints the artifact's
SHA256 checksum. Run from anywhere: `python scripts/build-python.py`.
"""

from __future__ import annotations

import hashlib
import platform
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src-python" / "main.py"
BIN_DIR = ROOT / "bin"
WORK_DIR = ROOT / "build" / "pyinstaller"

# Runtime modules PyInstaller must see imported to bundle them; the sidecar
# imports pyautogui/PIL lazily inside functions, so collection is explicit.
COLLECT_MODULES = ("pyautogui", "pyscreeze", "mouseinfo", "pygetwindow", "pytweening")


def artifact_name() -> str:
    """Binary name matching the Node provider's platformTag() resolution."""
    if sys.platform == "win32":
        machine = platform.machine().lower()
        arch = {"amd64": "x64", "x86_64": "x64"}.get(machine, machine)
        return f"dsh-cu-server-win-{arch}.exe"
    if sys.platform == "darwin":
        return f"dsh-cu-server-macos-{platform.machine().lower()}"
    raise SystemExit(f"build-python.py: unsupported platform {sys.platform!r} (Windows and macOS only)")


def main() -> int:
    try:
        import PyInstaller  # noqa: F401
    except ImportError:
        print(
            "PyInstaller is not installed. Install it first:\n\n"
            "    pip install pyinstaller\n",
            file=sys.stderr,
        )
        return 1

    if not SRC.is_file():
        print(f"build-python.py: entry script missing at {SRC}", file=sys.stderr)
        return 1

    # PyInstaller bundles what the current interpreter can import, so the
    # sidecar's runtime dependencies must be present in this environment.
    missing = []
    for module in ("pyautogui", "PIL"):
        try:
            __import__(module)
        except ImportError:
            missing.append(module)
    if missing:
        print(
            "build-python.py: missing runtime dependencies: " + ", ".join(missing)
            + "\nInstall them first:\n\n"
            "    pip install -r src-python/requirements.txt\n",
            file=sys.stderr,
        )
        return 1

    name = artifact_name()

    # Clean previous outputs so a stale binary never masquerades as fresh.
    for old in BIN_DIR.glob("dsh-cu-server-*"):
        old.unlink()
    shutil.rmtree(WORK_DIR, ignore_errors=True)
    BIN_DIR.mkdir(exist_ok=True)

    collect_args: list[str] = []
    for module in COLLECT_MODULES:
        try:
            __import__(module)
        except ImportError:
            continue
        collect_args += ["--collect-submodules", module]

    command = [
        sys.executable, "-m", "PyInstaller",
        "--noconfirm",
        "--onefile",
        # stdio MCP protocol: stdin/stdout must stay attached, so no --windowed.
        "--console",
        "--name", name.removesuffix(".exe"),
        "--distpath", str(BIN_DIR),
        "--workpath", str(WORK_DIR / "work"),
        "--specpath", str(WORK_DIR),
        "--paths", str(ROOT / "src-python"),
        *collect_args,
        str(SRC),
    ]
    print("running:", " ".join(command))
    result = subprocess.run(command, cwd=str(ROOT))
    if result.returncode != 0:
        print(f"build-python.py: PyInstaller failed with exit code {result.returncode}", file=sys.stderr)
        return result.returncode

    artifact = BIN_DIR / name
    if not artifact.is_file():
        print(f"build-python.py: expected artifact missing at {artifact}", file=sys.stderr)
        return 1

    digest = hashlib.sha256(artifact.read_bytes()).hexdigest()
    size_mib = artifact.stat().st_size / (1024 * 1024)
    print(f"\nartifact: {artifact}")
    print(f"size:     {size_mib:.1f} MiB")
    print(f"sha256:   {digest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
