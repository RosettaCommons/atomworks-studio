"""Validate the shared website/extension release version."""

from __future__ import annotations

import argparse
import json
import os
import re
from pathlib import Path

STUDIO_ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tag", default=None)
    parser.add_argument("--github-output", action="store_true")
    arguments = parser.parse_args()

    version = (STUDIO_ROOT / "VERSION").read_text(encoding="utf-8").strip()
    if (
        re.fullmatch(
            r"(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?",
            version,
        )
        is None
    ):
        raise SystemExit(f"invalid Annotation Studio version: {version!r}")

    manifests = {
        "workspace": STUDIO_ROOT / "package.json",
        "website": STUDIO_ROOT / "packages" / "web" / "package.json",
        "VS Code extension": STUDIO_ROOT / "packages" / "vscode" / "package.json",
    }
    for label, path in manifests.items():
        manifest = json.loads(path.read_text(encoding="utf-8"))
        if manifest.get("version") != version:
            raise SystemExit(f"{label} version {manifest.get('version')!r} does not match VERSION {version!r}")
    python_manifests = {
        "Studio application": STUDIO_ROOT / "pyproject.toml",
        "Editing core": STUDIO_ROOT / "packages" / "editing" / "pyproject.toml",
        "RFD4 provider": STUDIO_ROOT / "providers" / "rfd4" / "pyproject.toml",
        "PyMOL plugin": STUDIO_ROOT / "packages" / "pymol-plugin" / "pyproject.toml",
    }
    for label, path in python_manifests.items():
        project_section = path.read_text(encoding="utf-8").split("[project]", 1)[-1].split("\n[", 1)[0]
        version_match = re.search(r'^version\s*=\s*"([^"]+)"\s*$', project_section, re.MULTILINE)
        package_version = version_match.group(1) if version_match else None
        if package_version != version:
            raise SystemExit(f"{label} version {package_version!r} does not match VERSION {version!r}")

    rust_manifests = {
        "WASM core": STUDIO_ROOT / "packages" / "core" / "Cargo.toml",
        "Patinae launcher": STUDIO_ROOT / "packages" / "patinae-plugin" / "Cargo.toml",
    }
    for label, path in rust_manifests.items():
        version_match = re.search(
            r'^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"\s*$',
            path.read_text(encoding="utf-8"),
            re.MULTILINE,
        )
        crate_version = version_match.group(1) if version_match else None
        if crate_version != version:
            raise SystemExit(f"{label} version {crate_version!r} does not match VERSION {version!r}")

    for workflow in (STUDIO_ROOT / ".github" / "workflows").glob("*.yaml"):
        for action, revision in re.findall(r"uses:\s*([^@\s]+)@([^\s#]+)", workflow.read_text(encoding="utf-8")):
            if re.fullmatch(r"[0-9a-f]{40}", revision) is None:
                raise SystemExit(f"{workflow.name}: {action} is not pinned to a commit SHA: {revision}")

    tag = arguments.tag or os.environ.get("GITHUB_REF_NAME", "")
    if tag and (arguments.tag is not None or tag.startswith("v")) and tag != f"v{version}":
        raise SystemExit(f"release tag {tag!r} must equal v{version}")

    if arguments.github_output:
        output = os.environ.get("GITHUB_OUTPUT")
        if not output:
            raise SystemExit("GITHUB_OUTPUT is required with --github-output")
        with Path(output).open("a", encoding="utf-8") as handle:
            handle.write(f"version={version}\n")
    print(version)


if __name__ == "__main__":
    main()
