"""Bundle the already-built browser application into Python distributions."""

from __future__ import annotations

import shutil
from pathlib import Path

from hatchling.builders.hooks.plugin.interface import BuildHookInterface


class CustomBuildHook(BuildHookInterface):
    """Stage Vite output inside the importable package before each build."""

    PLUGIN_NAME = "custom"

    def initialize(self, version: str, build_data: dict) -> None:
        if version == "editable":
            return
        for source_dir, name in (("packages/web/dist", "web"), ("docs/_build/html", "guide")):
            source = Path(self.root) / source_dir
            destination = Path(self.root) / "packages/api/annotation_studio" / name
            if (source / "index.html").is_file():
                shutil.rmtree(destination, ignore_errors=True)
                shutil.copytree(source, destination, ignore=shutil.ignore_patterns(".doctrees", "__pycache__", "*.bak"))
            elif not (destination / "index.html").is_file():
                raise RuntimeError(f"build {source_dir} before building Studio (make build)")
            # Also include generated assets when rebuilding a wheel from its sdist.
            prefix = "packages/api/" if self.target_name == "sdist" else ""
            build_data.setdefault("force_include", {})[str(destination)] = f"{prefix}annotation_studio/{name}"
