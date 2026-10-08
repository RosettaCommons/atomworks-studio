"""Shared fixtures for document serialization regressions."""

from datetime import datetime

import pytest
from atomworks.io.utils import io_utils


@pytest.fixture
def stable_cif_metadata(monkeypatch):
    """Keep CIF export timestamps fixed when comparing document contents."""

    class FixedDateTime(datetime):
        @classmethod
        def now(cls, tz=None):
            return cls(2026, 9, 29, tzinfo=tz)

    monkeypatch.setattr(io_utils, "datetime", FixedDateTime)
