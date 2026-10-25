"""Extract the built browser bundle from a verified wheel.

The wheel a release publishes already carries the browser application (see `hatch_build.py`). Hosts that embed Studio
through `window.atomworksStudio` serve those files themselves and do not want a Python install, so the release also
offers them on their own. Taking them out of the wheel keeps the two identical by construction.
"""

from __future__ import annotations

import argparse
import zipfile
from pathlib import Path

BUNDLE_PREFIX = "annotation_studio/web/"


def extract(wheel: Path, destination: Path) -> int:
    with zipfile.ZipFile(wheel) as archive:
        names = [name for name in archive.namelist() if name.startswith(BUNDLE_PREFIX) and not name.endswith("/")]
        if not names:
            raise SystemExit(f"{wheel} contains no browser bundle under {BUNDLE_PREFIX}")
        for name in names:
            target = destination / Path(name).relative_to(BUNDLE_PREFIX)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(archive.read(name))
    if not (destination / "index.html").exists():
        raise SystemExit(f"{wheel} browser bundle has no index.html")
    return len(names)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("wheel", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    print(f"extracted {extract(args.wheel, args.destination)} files to {args.destination}")
