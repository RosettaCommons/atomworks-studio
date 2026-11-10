# /// script
# requires-python = ">=3.12"
# dependencies = ["packaging>=24,<27"]
# ///
"""Check that Studio archives contain the complete browser application."""

from __future__ import annotations

import argparse
import hashlib
import re
import tarfile
import tomllib
import zipfile
from pathlib import Path

from packaging.version import Version

_SDIST_PACKAGES = {
    "atomworks_studio_editing": "packages/editing/atomworks_studio_editing",
    "atomworks_studio_pymol": "packages/pymol-plugin/atomworks_studio_pymol",
    "atomworks_studio_rfd4": "providers/rfd4/atomworks_studio_rfd4",
}


def check_archive(path: Path) -> None:
    if path.suffix == ".whl":
        with zipfile.ZipFile(path) as archive:
            contents = {name: archive.read(name) for name in archive.namelist() if not name.endswith("/")}
    else:
        with tarfile.open(path) as archive:
            contents = {}
            for member in archive.getmembers():
                if member.isfile():
                    stream = archive.extractfile(member)
                    assert stream is not None
                    contents[member.name.split("/", 1)[1]] = stream.read()
    source_prefix = "" if path.suffix == ".whl" else "providers/rfd4/"
    rfd4_prefix = source_prefix + "atomworks_studio_rfd4/_upstream/"
    manifest_name = "UPSTREAM.toml" if path.suffix == ".whl" else None
    manifest_bytes = (
        contents[rfd4_prefix + "UPSTREAM.toml"] if manifest_name else contents["providers/rfd4/UPSTREAM.toml"]
    )
    manifest = tomllib.loads(manifest_bytes.decode())
    assert manifest["repository"] == "https://github.com/RosettaCommons/RFD4-Proteina.git"
    for name, digest in manifest["files"].items():
        assert hashlib.sha256(contents[rfd4_prefix + name]).hexdigest() == digest, f"{path.name}: changed RFD4 {name}"
    for package in ("atomworks_studio_editing", "atomworks_studio_pymol", "atomworks_studio_rfd4"):
        init = package + "/__init__.py" if path.suffix == ".whl" else _SDIST_PACKAGES[package] + "/__init__.py"
        assert init in contents, f"{path.name}: missing {init}"
    prefix = "annotation_studio/web/" if path.suffix == ".whl" else "packages/api/annotation_studio/web/"
    names = {name.removeprefix(prefix) for name in contents if name.startswith(prefix)}
    required = {"index.html", "manifest.webmanifest", "sw.js", "assets/patinae_web_bg.wasm"}
    assert required <= names, f"{path.name}: missing {sorted(required - names)}"
    assert any(name.startswith("assets/annotation_studio_core_bg-") and name.endswith(".wasm") for name in names), (
        f"{path.name}: CIF WASM is missing"
    )
    index = contents[prefix + "index.html"].decode()
    for asset in re.findall(r'(?:src|href)="(/assets/[^"]+)"', index):
        assert asset.lstrip("/") in names, f"{path.name}: missing {asset}"
    assert b"__BUILD_VERSION__" not in contents[prefix + "sw.js"], f"{path.name}: unbuilt service worker"
    guide_prefix = prefix.removesuffix("web/") + "guide/"
    assert not any("/.doctrees/" in name or name.endswith(".bak") for name in contents), "build caches in archive"
    for name in (
        "index.html",
        "TUTORIAL.html",
        "INTEGRATIONS.html",
        "search.html",
        "searchindex.js",
        "_static/studio.js",
    ):
        assert contents.get(guide_prefix + name), f"{path.name}: missing guide/{name}"
    # The packaged guide is opened from a local server on the user's own machine, often beside a structure they are
    # working on in confidence, so it must not load scripts from anywhere else. Usage analytics belong to the hosted
    # documentation only (docs/conf.py, STUDIO_DOCS_ANALYTICS), which is built separately.
    for name, data in contents.items():
        if name.startswith(guide_prefix) and name.endswith(".html"):
            external = re.findall(rb'<script[^>]*\bsrc="(https?://[^"]+)"', data)
            assert not external, f"{path.name}: {name} loads third-party scripts: {[x.decode() for x in external]}"
    print(f"{path.name}: {len(names)} browser assets and packaged interactive guide verified")


def check_manifest(directory: Path, root: Path) -> None:
    project = tomllib.loads((root / "pyproject.toml").read_text())["project"]
    stem = project["name"].replace("-", "_") + "-" + str(Version(project["version"]))
    expected = {stem + "-py3-none-any.whl", stem + ".tar.gz"}
    actual = {path.name for path in directory.iterdir() if path.is_file() and path.name != ".gitignore"}
    assert actual == expected, (
        f"Distribution manifest mismatch: missing={expected - actual}, unexpected={actual - expected}"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    check_manifest(args.directory, Path(__file__).resolve().parents[1])
    archives = sorted(args.directory.glob("atomworks_studio-[0-9]*"))
    archives = [path for path in archives if path.suffix == ".whl" or path.name.endswith(".tar.gz")]
    if not archives:
        parser.error("No Studio wheels or source archives found")
    for path in archives:
        check_archive(path)


if __name__ == "__main__":
    main()
