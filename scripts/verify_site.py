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
    require(len(catalog["devices"]) == 6, "expected six hardware selections")
    profile_count = sum(len(device["profiles"]) for device in catalog["devices"])
    require(profile_count == 13, f"expected 13 profiles, found {profile_count}")

    ids = re.findall(r'\bid="([^"]+)"', html)
    require(len(ids) == len(set(ids)), "HTML contains duplicate IDs")
    for required_id in ("device-grid", "profile-grid", "flash-button", "verify-boot", "server-onboarding"):
        require(required_id in ids, f"missing HTML control: {required_id}")

    artifacts = []
    for device in catalog["devices"]:
        require(device["flash_method"] in ("esp32", "uf2"), f"bad flash method: {device['id']}")
        for profile in device["profiles"]:
            require(profile["onboarding"] in ("companion", "companion-web", "server-core", "server-network", "room-core", "room-network"), f"bad onboarding: {profile['id']}")
            for kind in ("update", "recovery"):
                if kind not in profile:
                    continue
                artifact = profile[kind]
                artifacts.append(artifact)
                require(re.fullmatch(r"[0-9a-f]{64}", artifact["sha256"]), f"bad SHA-256: {artifact['name']}")
                require(re.fullmatch(r"[0-9a-f]{32}", artifact["md5"]), f"bad MD5: {artifact['name']}")
                require(artifact["local_url"] == f"/firmware/{artifact['name']}", f"bad local URL: {artifact['name']}")
                require(artifact["size"] > 100_000, f"implausible firmware size: {artifact['name']}")
    require(len(artifacts) == 22, f"expected 22 flash artifacts, found {len(artifacts)}")
    require(len({artifact["name"] for artifact in artifacts}) == len(artifacts), "duplicate artifact name")

    for contract in (
        'crypto.subtle.digest("SHA-256"',
        "flashMd5sum(address, bytes.byteLength)",
        "Wrong chip.",
        'set path.hash.mode 2',
        "INFO_UF2.TXT",
        "Passwords remain in this tab only",
    ):
        require(contract in html + js, f"missing safety contract: {contract}")
    require("eraseAll: false" in js, "ESP updates must not erase the whole flash")
    require("localStorage" not in js and "sessionStorage" not in js, "credentials/state must not be browser-persisted")
    print(f"Verified flasher: 6 devices, {profile_count} profiles, {len(artifacts)} exact artifacts")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
