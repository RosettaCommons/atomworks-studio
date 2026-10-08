"""Static package-boundary checks for migrated Studio code."""

from __future__ import annotations

import ast
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE_ROOTS = (ROOT / "packages", ROOT / "providers")
LEGACY_PLUGIN_NAMESPACES = (
    "atomworks.pymol_plugin",
    "rfproteina.pymol",
    "atomworks.ml.utils.visualize",
)


def _imported_modules(path: Path) -> list[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    modules: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            modules.extend(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            modules.append(node.module)
    return modules


def test_studio_does_not_import_legacy_plugin_namespaces() -> None:
    violations: list[str] = []
    for source_root in SOURCE_ROOTS:
        for path in source_root.rglob("*.py"):
            for module in _imported_modules(path):
                if module.startswith(LEGACY_PLUGIN_NAMESPACES):
                    violations.append(f"{path.relative_to(ROOT)} imports {module}")
    # Scientific save validation is canonical upstream and isolated from editors.
    worker = ROOT / "providers/rfd4/atomworks_studio_rfd4/_validate.py"
    for source_root in SOURCE_ROOTS:
        for path in source_root.rglob("*.py"):
            if path != worker and "rfproteina.conditions_reporting" in _imported_modules(path):
                violations.append(f"{path.relative_to(ROOT)} imports model reports outside the worker")
    assert not violations, "\n".join(violations)


def test_document_and_rfd4_editing_import_without_service_or_runtime() -> None:
    import subprocess
    import sys

    script = """
import importlib.abc
import os
import sys
class BlockRuntime(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname.startswith(("annotation_studio", "fastapi", "pymol", "rfproteina.")):
            raise AssertionError("editor imported runtime: " + fullname)
sys.meta_path.insert(0, BlockRuntime())
before = dict(os.environ)
from atomworks_studio_editing.document import StudioDocument
from atomworks_studio_rfd4 import CONDITION_PROVIDER
assert CONDITION_PROVIDER.definitions
assert "rfproteina" not in sys.modules
assert dict(os.environ) == before
"""
    result = subprocess.run([sys.executable, "-c", script], capture_output=True, text=True, timeout=60)
    assert result.returncode == 0, result.stderr


def test_editing_package_does_not_depend_on_service_or_renderers() -> None:
    forbidden = ("annotation_studio", "atomworks_studio_pymol", "atomworks_studio_rfd4", "fastapi", "pymol")
    violations = [
        f"{path.relative_to(ROOT)} imports {module}"
        for path in (ROOT / "packages/editing").rglob("*.py")
        for module in _imported_modules(path)
        if module.startswith(forbidden)
    ]
    assert not violations, "\n".join(violations)
