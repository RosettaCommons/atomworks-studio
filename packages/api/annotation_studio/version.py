"""Annotation Studio distribution version."""

from __future__ import annotations

from importlib.metadata import PackageNotFoundError, version
from pathlib import Path

try:
    __version__ = version("atomworks-studio")
except PackageNotFoundError:
    version_file = Path(__file__).resolve().parents[3] / "VERSION"
    __version__ = version_file.read_text(encoding="utf-8").strip() if version_file.is_file() else "development"
