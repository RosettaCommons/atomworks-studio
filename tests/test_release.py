"""Reject release refs and artifact directories that could publish the wrong build."""

import importlib.util
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("distribution_assets", ROOT / "scripts/check_distribution_assets.py")
assets = importlib.util.module_from_spec(spec)
spec.loader.exec_module(assets)


@pytest.mark.parametrize("tag", ["main", "vscode-latest", "v9.9.9", "0.1.0"])
def test_rejects_nonrelease_or_mismatched_tags(tag):
    result = subprocess.run(
        [sys.executable, str(ROOT / "scripts/verify_distribution.py"), "--tag", tag],
        capture_output=True,
        text=True,
    )
    assert result.returncode != 0
    assert "release tag" in result.stderr


def test_accepts_matching_release_tag():
    tag = "v" + (ROOT / "VERSION").read_text().strip()
    subprocess.run([sys.executable, str(ROOT / "scripts/verify_distribution.py"), "--tag", tag], check=True)


@pytest.fixture
def distribution(tmp_path):
    root = tmp_path / "source"
    root.mkdir()
    (root / "pyproject.toml").write_text('[project]\nname = "atomworks-studio"\nversion = "0.1.0"\n')
    dist = tmp_path / "dist"
    dist.mkdir()
    for name in ("atomworks_studio-0.1.0-py3-none-any.whl", "atomworks_studio-0.1.0.tar.gz"):
        (dist / name).touch()
    return root, dist


def test_accepts_complete_manifest(distribution):
    root, dist = distribution
    (dist / ".gitignore").write_text("*\n")
    assets.check_manifest(dist, root)


def test_rejects_missing_source_archive(distribution):
    root, dist = distribution
    (dist / "atomworks_studio-0.1.0.tar.gz").unlink()
    with pytest.raises(AssertionError, match=r"missing=.*tar\.gz"):
        assets.check_manifest(dist, root)


def test_rejects_stale_distribution(distribution):
    root, dist = distribution
    (dist / "atomworks_annotation_studio-0.1.0-py3-none-any.whl").touch()
    with pytest.raises(AssertionError, match=r"unexpected=.*atomworks_annotation_studio"):
        assets.check_manifest(dist, root)


def test_normalizes_prerelease_wheel_versions(distribution):
    root, dist = distribution
    (root / "pyproject.toml").write_text('[project]\nname = "atomworks-studio"\nversion = "0.1.0-rc.1"\n')
    for path in dist.iterdir():
        path.rename(path.with_name(path.name.replace("0.1.0", "0.1.0rc1")))
    assets.check_manifest(dist, root)
