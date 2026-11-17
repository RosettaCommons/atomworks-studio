"""Shared fixtures for document serialization regressions."""

import importlib.util
import os
from datetime import datetime

import pytest
from atomworks.io.utils import io_utils


@pytest.fixture(autouse=True)
def stable_cif_metadata(monkeypatch):
    """Keep CIF export timestamps fixed in every test, so two exports of one document compare equal."""

    class FixedDateTime(datetime):
        @classmethod
        def now(cls, tz=None):
            return cls(2026, 9, 29, tzinfo=tz)

    monkeypatch.setattr(io_utils, "datetime", FixedDateTime)


@pytest.fixture(scope="session", autouse=True)
def native_qt_application():
    """Keep one Qt application alive across native tests and their deferred events."""
    if importlib.util.find_spec("pymol") is None:
        yield None
        return
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    from pymol.Qt import QtWidgets

    application = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])
    application.setQuitOnLastWindowClosed(False)
    yield application
