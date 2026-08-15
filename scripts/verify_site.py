#!/usr/bin/env python3
"""Static, network-free release checks for the NeonPocketMC flasher."""

from __future__ import annotations

import hashlib
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
    require(profile_count == 21, f"expected 21 profiles, found {profile_count}")

    ids = re.findall(r'\bid="([^"]+)"', html)
    require(len(ids) == len(set(ids)), "HTML contains duplicate IDs")
    for required_id in (
        "device-grid",
        "profile-grid",
        "flash-button",
        "verify-boot",
        "server-onboarding",
        "wdg-onboarding",
        "deskos-onboarding",
        "deskos-bridge-button",
        "deskos-bridge-verify",
        "deskos-sd-button",
        "deskos-sd-verify",
    ):
        require(required_id in ids, f"missing HTML control: {required_id}")

    sd_bundle = json.loads(
        (ROOT / "assets/deskos-sd/bundle.json").read_text(encoding="utf-8")
    )
    require(sd_bundle.get("schema") == 1, "bad DeskOS SD bundle schema")
    require(sd_bundle.get("device") == "deskos-d1l", "bad DeskOS SD device")
    require(len(sd_bundle.get("directories", [])) == 9, "bad DeskOS SD directory count")
    require(len(sd_bundle.get("files", [])) == 5, "bad DeskOS SD file count")
    targets = set()
    for file in sd_bundle["files"]:
        target = file["target"]
        require(target.startswith("deskos/") and ".." not in target, f"unsafe SD target: {target}")
        require(target not in targets, f"duplicate SD target: {target}")
        targets.add(target)
        source = ROOT / file["url"].lstrip("/")
        require(source.is_file(), f"missing SD source: {source}")
        payload = source.read_bytes()
        require(len(payload) == file["size"], f"SD source size mismatch: {target}")
        require(
            hashlib.sha256(payload).hexdigest() == file["sha256"],
            f"SD source SHA-256 mismatch: {target}",
        )

    artifacts = []
    for device in catalog["devices"]:
        require(device["flash_method"] in ("esp32", "uf2"), f"bad flash method: {device['id']}")
        for profile in device["profiles"]:
            require(profile["onboarding"] in ("companion", "companion-usb", "companion-web", "server-core", "server-network", "room-core", "room-network", "deskos", "wdg-sidecar"), f"bad onboarding: {profile['id']}")
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
    require(len(artifacts) == 35, f"expected 35 flash artifacts, found {len(artifacts)}")
    require(len({artifact["name"] for artifact in artifacts}) == len(artifacts), "duplicate artifact name")

    deskos = next(device for device in catalog["devices"] if device["id"] == "deskos-d1l")
    require((deskos["usb_vid"], deskos["usb_pid"]) == (0x1A86, 0x7523), "bad D1L USB identity")
    require(deskos["tag"] == "v1.7.6", "wrong DeskOS release")
    require(deskos["commit"] == "92f838b120cf6e5586d2c69eae207a58b344cd75", "wrong DeskOS commit")
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
        "Complete DeskOS setup",
        "Prepare SD card",
        "No existing file was replaced",
        "artifact.address",
    ):
        require(contract in html + js, f"missing safety contract: {contract}")
    bridge = js.split("async function installDeskOsBridge", 1)[1].split(
        "async function fetchDeskOsSdBundle", 1
    )[0]
    require(
        bridge.index("const directory = await window.showDirectoryPicker")
        < bridge.rindex("fetchFirmware"),
        "DeskOS bridge picker must precede the firmware download",
    )
    sd_setup = js.split("async function prepareDeskOsSdCard", 1)[1].split(
        "async function verifyDeskOsStorage", 1
    )[0]
    require(
        sd_setup.index("showDirectoryPicker") < sd_setup.index("fetchDeskOsSdBundle"),
        "DeskOS SD picker must precede package downloads",
    )
    require("Refusing to replace a different existing file" in js, "SD setup must fail closed")
    require("eraseAll: false" in js, "ESP updates must not erase the whole flash")
    wdg_profiles = [
        (device, profile)
        for device in catalog["devices"]
        for profile in device["profiles"]
        if profile["id"] == "wdg-mesh-sidecar"
    ]
    require(len(wdg_profiles) == 3, "expected RCC6, V3 and V4 WDG profiles")
    for device, profile in wdg_profiles:
        require(profile["update"]["address"] == 0x10000, f"WDG update address is unsafe: {device['id']}")
        require("recovery" not in profile, f"WDG profile must be app-only: {device['id']}")
    v4_wdg = next(profile for device, profile in wdg_profiles if device["id"] == "heltec-v4")
    require("hardware validation pending" in v4_wdg["summary"].lower(), "V4 status must fail closed")
    require("localStorage" not in js and "sessionStorage" not in js, "credentials/state must not be browser-persisted")
    print(f"Verified flasher: 7 devices, {profile_count} profiles, {len(artifacts)} exact artifacts")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
