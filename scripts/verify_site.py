#!/usr/bin/env python3
"""Static, network-free release checks for the NeonPocketMC flasher."""

from __future__ import annotations

import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(message)


def main() -> int:
    catalog = json.loads((ROOT / "catalog.json").read_text(encoding="utf-8"))
    profiles = json.loads((ROOT / "profiles.json").read_text(encoding="utf-8"))
    html = (ROOT / "index.html").read_text(encoding="utf-8")
    js = (ROOT / "flasher.js").read_text(encoding="utf-8")

    require(catalog["schema"] == profiles["schema"] == 1, "unsupported catalog schema")
    require(len(catalog["devices"]) == 7, "expected seven hardware selections")
    profile_count = sum(len(device["profiles"]) for device in catalog["devices"])
    require(profile_count == 18, f"expected 18 profiles, found {profile_count}")

    ids = re.findall(r'\bid="([^"]+)"', html)
    require(len(ids) == len(set(ids)), "HTML contains duplicate IDs")
    for required_id in ("device-grid", "profile-grid", "flash-button", "verify-boot", "server-onboarding", "deskos-onboarding", "deskos-bridge-button"):
        require(required_id in ids, f"missing HTML control: {required_id}")

    artifacts = []
    for device in catalog["devices"]:
        require(device["flash_method"] in ("esp32", "uf2"), f"bad flash method: {device['id']}")
        for profile in device["profiles"]:
            require(profile["onboarding"] in ("companion", "companion-usb", "companion-web", "server-core", "server-network", "room-core", "room-network", "deskos"), f"bad onboarding: {profile['id']}")
            for kind in ("update", "recovery", "bridge"):
                if kind not in profile:
                    continue
                artifact = profile[kind]
                artifacts.append(artifact)
                require(re.fullmatch(r"[0-9a-f]{64}", artifact["sha256"]), f"bad SHA-256: {artifact['name']}")
                require(re.fullmatch(r"[0-9a-f]{32}", artifact["md5"]), f"bad MD5: {artifact['name']}")
                require(
                    artifact["local_url"] == f"/firmware/{artifact['sha256']}/{artifact['name']}",
                    f"bad local URL: {artifact['name']}",
                )
                require(artifact["size"] > 100_000, f"implausible firmware size: {artifact['name']}")
    require(len(artifacts) == 32, f"expected 32 flash artifacts, found {len(artifacts)}")
    require(len({artifact["name"] for artifact in artifacts}) == len(artifacts), "duplicate artifact name")

    deskos = next(device for device in catalog["devices"] if device["id"] == "deskos-d1l")
    require((deskos["usb_vid"], deskos["usb_pid"]) == (0x1A86, 0x7523), "bad D1L USB identity")
    require(deskos["tag"] == "v1.7.5", "wrong DeskOS release")
    require(deskos["commit"] == "b719faaed93032211988c00b6a5c0c0ee74ef60b", "wrong DeskOS commit")
    deskos_profile = deskos["profiles"][0]
    require(deskos_profile["update"]["address"] == 0x20000, "DeskOS update must use 0x20000")
    require(deskos_profile["recovery"]["address"] == 0, "DeskOS clean image must use 0x0")
    require(deskos_profile["bridge"]["name"].endswith(".uf2"), "DeskOS bridge must be UF2")

    for contract in (
        'crypto.subtle.digest("SHA-256"',
        "flashMd5sum(address, bytes.byteLength)",
        "Wrong chip.",
        'set path.hash.mode 2',
        "INFO_UF2.TXT",
        "Passwords remain in this tab only",
        "Fresh clean install deletes the existing DeskOS identity",
        "DeskOS identity verified",
        "artifact.address",
    ):
        require(contract in html + js, f"missing safety contract: {contract}")
    require("eraseAll: false" in js, "ESP updates must not erase the whole flash")
    require("localStorage" not in js and "sessionStorage" not in js, "credentials/state must not be browser-persisted")
    print(f"Verified flasher: 7 devices, {profile_count} profiles, {len(artifacts)} exact artifacts")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
