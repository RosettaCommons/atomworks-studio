"""Verify the pinned scientific definitions included in every distribution."""

import hashlib
import tomllib
from pathlib import Path

from hatchling.builders.hooks.plugin.interface import BuildHookInterface


class CustomBuildHook(BuildHookInterface):
    PLUGIN_NAME = "custom"

    def initialize(self, version: str, build_data: dict) -> None:
        root = Path(self.root)
        source = root / "atomworks_studio_rfd4/_upstream"
        manifest = root / "UPSTREAM.toml"
        if not manifest.is_file():
            manifest = source / "UPSTREAM.toml"
        metadata = tomllib.loads(manifest.read_text())
        for name, expected in metadata["files"].items():
            path = source / name
            if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != expected:
                raise RuntimeError(f"RFD4 {name} does not match pinned RosettaCommons revision {metadata['revision']}")
        build_data.setdefault("force_include", {})[str(manifest)] = (
            "atomworks_studio_rfd4/_upstream/UPSTREAM.toml"
        )
