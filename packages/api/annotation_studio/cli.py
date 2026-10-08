"""Launch the packaged Studio web application."""

from __future__ import annotations

import argparse
import os
from pathlib import Path

from annotation_studio.version import __version__


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Open AtomWorks Studio in a browser.")
    parser.add_argument("--version", action="version", version=f"AtomWorks Studio {__version__}")
    parser.add_argument("--host", default="127.0.0.1", help="Listen address (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8000, help="Listen port (default: 8000)")
    parser.add_argument("--vscode", action="store_true", help="Allow embedding in VS Code and Cursor")
    args = parser.parse_args(argv)
    if not 1 <= args.port <= 65535:
        parser.error("--port must be between 1 and 65535")
    package = Path(__file__).resolve().parent
    if not any((path / "index.html").is_file() for path in (package / "web", package.parents[1] / "web" / "dist")):
        parser.error("Browser assets are missing. Install a built wheel, or run `pnpm --dir packages/web build` first.")
    import uvicorn

    if args.vscode:
        os.environ["ANNOTATION_STUDIO_FRAME_ANCESTORS"] = (
            "'self' vscode-webview: vscode-file://vscode-app https://*.vscode-cdn.net"
        )
    print(f"AtomWorks Studio: http://{args.host}:{args.port}/", flush=True)
    uvicorn.run("annotation_studio.main:app", host=args.host, port=args.port)
