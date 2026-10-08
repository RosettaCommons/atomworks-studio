"""Shared fixtures for PyMOL plugin tests.

The whole module is skipped if PyMOL cannot be imported, so the regular
atomworks test suite is unaffected on systems without PyMOL.
"""

from pathlib import Path

import pytest

pytest.importorskip("pymol", reason="PyMOL is not installed in this env")

# Launch PyMOL headless and skip ``~/.pymolrc`` before any ``cmd`` access.
# Without ``-k`` PyMOL sources the user's pymolrc, which for developers who
# ran the plugin's register step re-runs ``pymol_plugin/__init__.py`` as a
# script and calls ``addmenuitemqt`` — unavailable in library mode and raises
# ``QtNotAvailableError``.
import pymol

pymol.finish_launching(["pymol", "-qck"])

from atomworks.io.config import ParseConfig
from atomworks_studio_pymol.bridge import load_structure
from atomworks_studio_pymol.state import STATE
from pymol import cmd

# Anchor: <repo>/packages/pymol-plugin/tests/conftest.py → <repo>
REPO_ROOT = Path(__file__).resolve().parents[3]
DATA_DIR = REPO_ROOT / "tests" / "fixtures"


# Keep this list small — each entry spawns a real PyMOL load.
CIF_FIXTURES: list[Path] = [
    REPO_ROOT / "packages/api/annotation_studio/examples/protein_binder.cif",
    DATA_DIR / "SAM_hbonds.cif",
]

# Exercise both NaN policies. With ``hide_nans=True`` (default plugin behaviour)
# atoms with NaN coords are dropped before PyMOL load, so PyMOL is a strict
# subset of the array. With ``hide_nans=False`` NaN coords are zeroed and every
# array row survives into PyMOL. Both paths must keep bridge invariants.
HIDE_NANS_OPTIONS: list[bool] = [True, False]

_FIXTURE_PARAMS = [(path, hide) for path in CIF_FIXTURES for hide in HIDE_NANS_OPTIONS]


def _fixture_id(param: tuple[Path, bool]) -> str:
    path, hide = param
    return f"{path.stem}-{'hide' if hide else 'show'}_nans"


@pytest.fixture(autouse=True)
def _clean_pymol_and_state() -> None:
    """Hard reset PyMOL and plugin state between tests."""
    cmd.reinitialize()
    STATE.clear_all()
    yield
    cmd.reinitialize()
    STATE.clear_all()


@pytest.fixture(params=_FIXTURE_PARAMS, ids=_fixture_id)
def loaded_cif(request: pytest.FixtureRequest) -> tuple[str, str]:
    """Load a CIF into PyMOL + STATE and return (path, obj_name).

    Parametrized over ``hide_nans`` so each test runs once with NaN-coord
    atoms dropped from PyMOL and once with them zeroed into PyMOL.
    """
    path, hide_nans = request.param
    if not path.exists():
        pytest.skip(f"test CIF missing: {path}")
    # Set before load so ``_load_array_into_pymol`` picks up the policy.
    STATE.hide_nans = hide_nans
    config = ParseConfig.from_preset(
        "minimal", build_assembly=["1"], load_standard_annotations=True, return_atom_array_plus=True
    )
    obj_name = load_structure(path, config=config, obj_name=path.stem)
    return str(path), obj_name
