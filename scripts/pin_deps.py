"""Check dependency pins that define a reproducible Studio distribution."""

from __future__ import annotations

import hashlib
import json
import re
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    web = json.loads((ROOT / "packages/web/package.json").read_text())
    assert web["dependencies"]["molstar"] == "5.11.0", "Mol* must be exact-pinned"
    patinae = tomllib.loads((ROOT / "vendor/patinae/UPSTREAM.toml").read_text())
    assert re.fullmatch(r"[0-9a-f]{40}", patinae["revision"])
    launcher = tomllib.loads((ROOT / "packages/patinae-plugin/Cargo.toml").read_text())
    assert launcher["dependencies"]["patinae-plugin"]["rev"] == patinae["revision"]
    assert web["dependencies"][patinae["package"]] == f"file:vendor/patinae-viewer-{patinae['version']}.tgz"

    patches = sorted((ROOT / "vendor/patinae/patches").glob("*.patch"))
    assert patches, "Patinae patch series is empty"

    manifest = tomllib.loads((ROOT / "dependencies.toml").read_text())
    atomworks_requirement = f"atomworks[ml]=={manifest['atomworks']['version']}"
    dependency_manifests = (
        ROOT / "pyproject.toml",
        ROOT / "packages/editing/pyproject.toml",
        ROOT / "packages/pymol-plugin/pyproject.toml",
    )
    for path in dependency_manifests:
        dependencies = tomllib.loads(path.read_text())["project"]["dependencies"]
        assert atomworks_requirement in dependencies, (
            f"{path.relative_to(ROOT)} must require the reviewed public AtomWorks release"
        )
        assert all("../../../" not in item for item in dependencies)

    rfd4 = manifest["rfd4"]
    assert re.fullmatch(r"[0-9a-f]{40}", rfd4["revision"]), "RFD4 revision must be a 40-hex commit"
    definitions = ROOT / "providers/rfd4"
    upstream = tomllib.loads((definitions / "UPSTREAM.toml").read_text())
    assert rfd4["revision"] == upstream["revision"]
    assert rfd4["repository"] == upstream["repository"]
    for name, expected in upstream["files"].items():
        path = definitions / "atomworks_studio_rfd4/_upstream" / name
        assert hashlib.sha256(path.read_bytes()).hexdigest() == expected, f"Changed RFD4 definition: {name}"

    print(
        json.dumps(
            {
                "atomworks": atomworks_requirement,
                "molstar": web["dependencies"]["molstar"],
                "patinae_revision": patinae["revision"],
                "patinae_patches": len(patches),
                "rfd4_revision": rfd4["revision"],
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
