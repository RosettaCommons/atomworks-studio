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
    if path.name.startswith("atomworks_annotation_studio_rfd4-"):
        prefix = "atomworks_studio_rfd4/_upstream/"
        manifest = tomllib.loads(contents[prefix + "UPSTREAM.toml"].decode())
        assert manifest["repository"] == "https://github.com/RosettaCommons/RFD4-Proteina.git"
        for name, digest in manifest["files"].items():
            assert hashlib.sha256(contents[prefix + name]).hexdigest() == digest, f"{path.name}: changed RFD4 {name}"
        print(f"{path.name}: pinned RFD4 definitions, vocabulary, and license verified")
        return
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
    print(f"{path.name}: {len(names)} browser assets and packaged interactive guide verified")


def check_manifest(directory: Path, root: Path) -> None:
    manifests = [root / "pyproject.toml"]
    manifests.extend((root / "packages").glob("*/pyproject.toml"))
    manifests.extend((root / "providers").glob("*/pyproject.toml"))
    expected = set()
    for manifest in manifests:
        project = tomllib.loads(manifest.read_text())["project"]
        stem = project["name"].replace("-", "_") + "-" + str(Version(project["version"]))
        expected.update((stem + "-py3-none-any.whl", stem + ".tar.gz"))
    actual = {path.name for path in directory.iterdir() if path.is_file() and path.name != ".gitignore"}
    assert actual == expected, (
        f"Distribution manifest mismatch: missing={expected - actual}, unexpected={actual - expected}"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    check_manifest(args.directory, Path(__file__).resolve().parents[1])
    archives = sorted(
        [
            *args.directory.glob("atomworks_studio-[0-9]*"),
            *args.directory.glob("atomworks_annotation_studio_rfd4-[0-9]*"),
        ]
    )
    archives = [path for path in archives if path.suffix == ".whl" or path.name.endswith(".tar.gz")]
    if not archives:
        parser.error("No Studio wheels or source archives found")
    for path in archives:
        check_archive(path)


if __name__ == "__main__":
    main()
