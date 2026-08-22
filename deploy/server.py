#!/usr/bin/env python3
"""Serve the NeonPocket flasher and proxy only catalog-pinned GitHub assets."""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import posixpath
import shutil
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import unquote, urlparse
from urllib.request import Request, urlopen


def load_artifacts(catalog_path: Path) -> dict[tuple[str, str], dict]:
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    artifacts: dict[tuple[str, str], dict] = {}
    for device in catalog["devices"]:
        for profile in device["profiles"]:
            for kind in ("update", "recovery", "bridge"):
                artifact = profile.get(kind)
                if not artifact:
                    continue
                key = (artifact["sha256"], artifact["name"])
                previous = artifacts.setdefault(key, artifact)
                if previous["url"] != artifact["url"] or previous["size"] != artifact["size"]:
                    raise ValueError(f"conflicting artifact definition: {artifact['name']}")
    if not artifacts:
        raise ValueError("catalog contains no firmware artifacts")
    return artifacts


class FlasherHandler(SimpleHTTPRequestHandler):
    server_version = "NeonPocketFlasher/1"

    def end_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Resource-Policy", "same-site")
        self.send_header(
            "Permissions-Policy",
            "camera=(), microphone=(), geolocation=(), payment=(), usb=(self), serial=(self)",
        )
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; base-uri 'self'; connect-src 'self' "
            "https://mg.canadaverse.org; frame-ancestors 'none'; img-src 'self' data:; "
            "object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
            "worker-src 'self'",
        )
        if self.path == "/catalog.json" or self.path.startswith("/assets/deskos-sd/"):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_HEAD(self) -> None:
        if self.path == "/healthz":
            self._health(head_only=True)
        elif self.path.startswith("/firmware/"):
            self._firmware(head_only=True)
        else:
            super().do_HEAD()

    def do_GET(self) -> None:
        if self.path == "/healthz":
            self._health(head_only=False)
        elif self.path.startswith("/firmware/"):
            self._firmware(head_only=False)
        else:
            super().do_GET()

    def _health(self, head_only: bool) -> None:
        body = b"ok\n"
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if not head_only:
            self.wfile.write(body)

    def _firmware(self, head_only: bool) -> None:
        parts = [unquote(part) for part in urlparse(self.path).path.split("/") if part]
        if len(parts) != 3 or parts[0] != "firmware":
            self.send_error(404)
            return
        sha256, name = parts[1], posixpath.basename(parts[2])
        artifact = self.server.artifacts.get((sha256, name))
        if not artifact:
            self.send_error(404, "firmware is not in the deployed catalog")
            return
        if head_only:
            self._firmware_headers(artifact)
            return
        request = Request(artifact["url"], headers={"User-Agent": "NeonPocketMC-Flasher/1"})
        response_started = False
        try:
            with urlopen(request, timeout=120) as upstream:
                length = int(upstream.headers.get("Content-Length", "0"))
                if length and length != artifact["size"]:
                    raise ValueError(f"GitHub size mismatch for {name}")
                self._firmware_headers(artifact)
                response_started = True
                shutil.copyfileobj(upstream, self.wfile, length=1024 * 1024)
        except (BrokenPipeError, ConnectionResetError):
            return
        except (HTTPError, URLError, OSError, ValueError) as error:
            self.log_error("firmware proxy failed: %s", error)
            if not response_started:
                self.send_error(502, "GitHub firmware download failed")

    def _firmware_headers(self, artifact: dict) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(artifact["size"]))
        self.send_header("Content-Disposition", f'attachment; filename="{artifact["name"]}"')
        self.send_header("Cache-Control", "public, max-age=3600")
        self.end_headers()


class FlasherServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, handler, artifacts):
        super().__init__(address, handler)
        self.artifacts = artifacts


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--site", type=Path, default=Path(os.environ.get("SITE_DIR", "/app/site")))
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8080")))
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    artifacts = load_artifacts(args.site / "catalog.json")
    for (sha256, name), artifact in artifacts.items():
        expected = f"/firmware/{sha256}/{name}"
        if artifact.get("local_url") != expected:
            raise SystemExit(f"bad proxy URL for {name}: {artifact.get('local_url')}")
    if args.self_test:
        print(f"Verified Pi server catalog: {len(artifacts)} exact GitHub artifacts")
        return 0
    os.chdir(args.site)
    mimetypes.add_type("application/wasm", ".wasm")
    server = FlasherServer(("0.0.0.0", args.port), FlasherHandler, artifacts)
    print(f"NeonPocket flasher listening on :{args.port} with {len(artifacts)} artifacts", flush=True)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
