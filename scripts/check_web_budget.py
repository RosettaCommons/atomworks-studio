"""Enforce the accepted browser-shell and lazy-renderer size budgets."""

from __future__ import annotations

import gzip
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "packages" / "web" / "dist" / "assets"
SHELL_GZIP_LIMIT = 80_000


def compressed_size(path: Path) -> int:
    return len(gzip.compress(path.read_bytes(), compresslevel=9))


def main() -> None:
    scripts = list(ASSETS.glob("*.js"))
    shell = next(path for path in scripts if path.name.startswith("index-"))
    shell_size = compressed_size(shell)
    if shell_size > SHELL_GZIP_LIMIT:
        raise SystemExit(f"browser shell is {shell_size} bytes gzip; budget is {SHELL_GZIP_LIMIT}")
    names = {path.name for path in scripts}
    if not any(name.startswith("molstar-") for name in names):
        raise SystemExit("Mol* lazy chunk is missing")
    if not any(name.startswith("patinae-") for name in names):
        raise SystemExit("Patinae lazy chunk is missing")
    print(json.dumps({"shell_gzip_bytes": shell_size, "limit": SHELL_GZIP_LIMIT}, sort_keys=True))


if __name__ == "__main__":
    main()
