"""Installation smoke tests that do not require a running PyMOL process."""

import runpy
from importlib.metadata import distribution, entry_points
from pathlib import Path

import atomworks_studio_pymol as plugin
import pytest
from packaging.requirements import Requirement


def test_plugin_entry_point_is_importable() -> None:
    assert callable(plugin.__init_plugin__)


def test_plugin_initialization_is_idempotent(monkeypatch) -> None:
    registrations: list[object | None] = []
    monkeypatch.setattr(plugin, "_INITIALIZED", False)
    monkeypatch.setattr(plugin, "find_spec", lambda _name: object())
    monkeypatch.setattr(plugin, "_register_plugin", registrations.append)

    plugin.__init_plugin__()
    plugin.__init_plugin__()

    assert registrations == [None]


def test_plugin_initialization_can_retry_after_unexpected_failure(monkeypatch) -> None:
    attempts = 0

    def fail_once(_app) -> None:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise RuntimeError("registration failed")

    monkeypatch.setattr(plugin, "_INITIALIZED", False)
    monkeypatch.setattr(plugin, "find_spec", lambda _name: object())
    monkeypatch.setattr(plugin, "_register_plugin", fail_once)

    with pytest.raises(RuntimeError, match="registration failed"):
        plugin.__init_plugin__()
    plugin.__init_plugin__()

    assert attempts == 2


def test_startup_file_loader_delegates_to_canonical_module(monkeypatch) -> None:
    registrations: list[object | None] = []
    monkeypatch.setattr(plugin, "_INITIALIZED", False)
    monkeypatch.setattr(plugin, "find_spec", lambda _name: object())
    monkeypatch.setattr(plugin, "_register_plugin", registrations.append)

    runpy.run_path(Path(plugin.__file__))
    plugin.__init_plugin__()

    assert registrations == [None]


def test_pymol_entry_point_targets_plugin_initializer() -> None:
    matching = [
        entry_point
        for entry_point in entry_points(group="pymol.plugins")
        if entry_point.name == "atomworks_studio" and entry_point.value == "atomworks_studio_pymol:__init_plugin__"
    ]
    assert matching
    assert matching[0].load() is plugin.__init_plugin__


def test_distribution_contains_only_the_standalone_namespace() -> None:
    installed = distribution("atomworks-studio-pymol")
    top_level = (installed.read_text("top_level.txt") or "").splitlines()
    assert top_level == ["atomworks_studio_pymol"]

    files = [str(path) for path in installed.files or ()]
    assert not any(path.startswith("atomworks/pymol_plugin/") for path in files)
    assert not any(path.startswith("rfproteina/pymol/") for path in files)


def test_distribution_has_no_studio_service_dependency() -> None:
    installed = distribution("atomworks-studio-pymol")
    dependency_names = {Requirement(requirement).name for requirement in installed.requires or ()}

    assert "atomworks-studio-api" not in dependency_names
