"""The installed entry point should work before importing the scientific stack."""

import subprocess
import sys
from unittest.mock import patch

import pytest
from annotation_studio.cli import main


def test_help_does_not_import_the_service():
    result = subprocess.run(
        [sys.executable, "-c", "from annotation_studio.cli import main; main(['--help'])"],
        text=True,
        capture_output=True,
        check=True,
    )
    assert "--port" in result.stdout
    assert "CCD_MIRROR" not in result.stderr


def test_launches_local_service_with_selected_port():
    with patch("pathlib.Path.is_file", return_value=True), patch("uvicorn.run") as run:
        main(["--port", "8123"])
    run.assert_called_once_with("annotation_studio.main:app", host="127.0.0.1", port=8123)


def test_missing_browser_assets_gives_build_instructions(capsys):
    with patch("pathlib.Path.is_file", return_value=False), pytest.raises(SystemExit) as error:
        main([])
    assert error.value.code == 2
    assert "Install a built wheel" in capsys.readouterr().err


@pytest.mark.parametrize("port", ["0", "65536", "invalid"])
def test_invalid_port_is_rejected(port):
    with pytest.raises(SystemExit) as error:
        main(["--port", port])
    assert error.value.code == 2


def test_vscode_launch_enables_only_editor_embedding(monkeypatch):
    import os

    monkeypatch.setenv("ANNOTATION_STUDIO_FRAME_ANCESTORS", "'self'")
    with patch("pathlib.Path.is_file", return_value=True), patch("uvicorn.run"):
        main(["--vscode"])
    policy = os.environ["ANNOTATION_STUDIO_FRAME_ANCESTORS"]
    assert "vscode-webview:" in policy
    assert "vscode-file://vscode-app" in policy
    assert "https://*.vscode-cdn.net" in policy
    assert "*" not in policy.split()


def test_normal_launch_preserves_embedding_policy(monkeypatch):
    import os

    policy = "'self' https://studio.example.org"
    monkeypatch.setenv("ANNOTATION_STUDIO_FRAME_ANCESTORS", policy)
    with patch("pathlib.Path.is_file", return_value=True), patch("uvicorn.run"):
        main([])
    assert os.environ["ANNOTATION_STUDIO_FRAME_ANCESTORS"] == policy
