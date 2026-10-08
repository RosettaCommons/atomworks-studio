"""Run pytest without allowing embedded host shutdown hooks to mask failures."""

from __future__ import annotations

import os
import sys

import pytest

exit_code = pytest.main()
sys.stdout.flush()
sys.stderr.flush()
os._exit(int(exit_code))
