"""Exercise an installed Studio wheel from a directory outside the checkout."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.error import URLError
from urllib.request import Request, urlopen


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("cif", type=Path)
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    cli = Path(sys.executable).with_name("atomworks-studio")
    subprocess.run([str(cli), "--help"], check=True, stdout=subprocess.DEVNULL)
    subprocess.run([sys.executable, "-m", "atomworks_studio", "--version"], check=True)
    base = f"http://127.0.0.1:{args.port}"

    def request(path: str, data: bytes | None = None, content_type: str = "application/json") -> bytes:
        req = Request(base + path, data=data, headers={"Content-Type": content_type})
        with urlopen(req, timeout=30) as response:
            return response.read()

    def post(path: str, data: dict) -> dict:
        return json.loads(request(path, json.dumps(data).encode()))

    with tempfile.TemporaryFile(mode="w+") as log:
        server = subprocess.Popen([str(cli), "--port", str(args.port)], stdout=log, stderr=log)
        try:
            deadline = time.monotonic() + 120
            while time.monotonic() < deadline:
                if server.poll() is not None:
                    raise RuntimeError("Studio exited before becoming ready")
                try:
                    assert json.loads(request("/api/health"))["status"] == "ok"
                    break
                except URLError:
                    time.sleep(0.25)
            else:
                raise TimeoutError("Studio did not start within 120 seconds")
            for path in (
                "/",
                "/manifest.webmanifest",
                "/assets/patinae_web_bg.wasm",
                "/api/schema",
                "/guide/",
                "/guide/TUTORIAL.html",
                "/guide/_static/studio.js",
                "/openapi.json",
            ):
                assert request(path), f"Empty response for {path}"
            assert {
                "sequence",
                "coordinate",
                "index",
                "hotspot",
                "cath_label",
                "coordinate_group",
            } <= json.loads(request("/api/schema"))["conditions"].keys()
            boundary = "studio-wheel-smoke"
            upload = (
                (
                    f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="input.cif"\r\n'
                    "Content-Type: chemical/x-mmcif\r\n\r\n"
                ).encode()
                + args.cif.read_bytes()
                + f"\r\n--{boundary}--\r\n".encode()
            )
            document = json.loads(request("/api/v1/sessions", upload, f"multipart/form-data; boundary={boundary}"))
            session = f"/api/v1/sessions/{document['session_id']}"
            applied = post(
                session + "/conditions",
                {
                    "condition": "sequence",
                    "atom_indices": [0],
                    "scope": "residue",
                    "enabled": True,
                },
            )
            assert applied["structure"]["condition_counts"]["sequence"] > 0
            annotation = json.loads(request(session + "/annotations/sequence"))["annotation"]
            assert 0 in annotation["values"][0]["atom_indices"]
            assert post(session + "/undo", {})["structure"]["revision"] > applied["structure"]["revision"]
            hotspot = post(
                session + "/conditions",
                {
                    "condition": "hotspot",
                    "atom_indices": [0],
                    "enabled": True,
                },
            )
            assert hotspot["structure"]["condition_counts"]["hotspot"] == 1
            assert json.loads(request(session + "/annotations/hotspot"))["annotation"]["count"] == 1
            post(session + "/undo", {})
            result = post(session + "/protonate", {"ph": 7.4})
            assert result["edit_result"]["hydrogen_count"] > 0
            selected = post(session + "/selections/query", {"expression": "element == 'H'"})
            assert selected["count"] == result["edit_result"]["hydrogen_count"]
            assert b"_atom_site." in request(session + "/cif")
            undone = post(session + "/undo", {})
            assert undone["structure"]["atom_count"] == document["structure"]["atom_count"]
            print(
                "Installed Studio: CLI, API, web/WASM, annotations, protonation, selection, CIF export and Undo passed"
            )
        except Exception:
            log.seek(0)
            print(log.read(), file=sys.stderr)
            raise
        finally:
            server.terminate()
            try:
                server.wait(timeout=15)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait()


if __name__ == "__main__":
    main()
