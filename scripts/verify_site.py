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
    scene_js = (ROOT / "scene.js").read_text(encoding="utf-8")
    css = (ROOT / "css" / "flasher.css").read_text(encoding="utf-8")

    require(catalog["schema"] == profiles["schema"] == 1, "unsupported catalog schema")
    require(len(catalog["devices"]) == 13, "expected thirteen hardware selections")
    profile_count = sum(len(device["profiles"]) for device in catalog["devices"])
    require(profile_count == 42, f"expected 42 profiles, found {profile_count}")

    ids = re.findall(r'\bid="([^"]+)"', html)
    require(len(ids) == len(set(ids)), "HTML contains duplicate IDs")
    for required_id in (
        "device-grid",
        "device-family-bar",
        "device-family-name",
        "change-device-family",
        "profile-grid",
        "flash-button",
        "verify-boot",
        "server-onboarding",
        "ulp-fields",
        "ulp-profile",
        "ulp-location-share",
        "ulp-latitude",
        "ulp-longitude",
        "ulp-note",
        "wdg-onboarding",
        "meshgangs-onboarding",
        "meshgangs-setup",
        "meshgangs-account-state",
        "meshgangs-enroll-link",
        "meshgangs-label",
        "meshgangs-wifi-fields",
        "meshgangs-wifi-ssid",
        "meshgangs-wifi-password",
        "meshgangs-ready-checks",
        "meshgangs-usb-key",
        "meshgangs-usb-key-value",
        "meshgangs-copy-key",
        "meshgangs-download-key",
        "deskos-onboarding",
        "deskos-bridge-button",
        "deskos-bridge-verify",
        "deskos-sd-button",
        "deskos-sd-verify",
        "deskos-install-progress",
        "deskos-required-action",
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
            require(profile["onboarding"] in ("companion", "companion-headless", "companion-usb", "companion-web", "repeater-web", "server-core", "server-network", "room-core", "room-network", "ulp-repeater", "deskos", "wdg-sidecar", "meshgangs-sidecar"), f"bad onboarding: {profile['id']}")
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
    require(len(artifacts) == 70, f"expected 70 flash artifacts, found {len(artifacts)}")
    require(len({artifact["name"] for artifact in artifacts}) == len(artifacts), "duplicate artifact name")

    heltec_v3 = next(device for device in catalog["devices"] if device["id"] == "heltec-v3")
    heltec_v3_profile = next(device for device in profiles["devices"] if device["id"] == "heltec-v3")
    require((heltec_v3["usb_vid"], heltec_v3["usb_pid"]) == (0x10C4, 0xEA60), "bad Heltec V3 CP2102 USB identity")
    require((heltec_v3_profile["usb_vid"], heltec_v3_profile["usb_pid"]) == (0x10C4, 0xEA60), "bad Heltec V3 source USB identity")
    for device_id in ("heltec-v3", "heltec-v4"):
        device = next(item for item in catalog["devices"] if item["id"] == device_id)
        ultimate = {profile["id"]: profile for profile in device["profiles"] if profile["id"].startswith("ultimate-")}
        require(set(ultimate) == {"ultimate-ble-companion-oled", "ultimate-web-companion-oled", "ultimate-repeater-web-oled"}, f"bad Ultimate profile set: {device_id}")
        require(ultimate["ultimate-repeater-web-oled"]["onboarding"] == "repeater-web", f"bad repeater onboarding: {device_id}")

    for family_id in ("radiocore", "heltec-oled", "solar-maker", "deskos"):
        require(f'id: "{family_id}"' in js, f"missing hardware family: {family_id}")
    require("data-device-family=" in js, "hardware family selection is missing")
    require("state.deviceFamily = deviceFamilies.find" in js, "deep links must restore their hardware family")
    require('const screenLabel = /oled/i.test(state.device.display) ? "OLED" : "TFT"' in js, "screen onboarding must match OLED versus TFT hardware")
    require("Ultimate BLE/Web companions" in (ROOT / "README.md").read_text(encoding="utf-8"), "Ultimate Heltec roles are missing from README")

    deskos = next(device for device in catalog["devices"] if device["id"] == "deskos-d1l")
    require((deskos["usb_vid"], deskos["usb_pid"]) == (0x1A86, 0x7523), "bad D1L USB identity")
    require(deskos["tag"] == "v1.7.9", "wrong DeskOS release")
    require(deskos["commit"] == "40a2edaa2f4f356955727d0b6e22662d55fec142", "wrong DeskOS commit")
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
        "flashing the ESP32 alone will not enable storage",
        "Complete DeskOS setup",
        "Prepare SD card",
        "No existing file was replaced",
        "artifact.address",
        "Silicon Labs CP210x driver",
        "Safari and Firefox are not supported",
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
    require("Installation complete" in js, "DeskOS clean install must have an explicit completion gate")
    require("completeCount === 3" in js, "DeskOS completion must require all three installation stages")
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
    require("hardware validated" in v4_wdg["summary"].lower(), "V4 validation status missing")
    require("unvalidated hardware" not in v4_wdg["features"], "stale V4 validation warning")
    require(v4_wdg["tag"] == "v1.0.0-rc.2", "wrong validated V4 release")
    require(v4_wdg["commit"] == "ecf1db13c153f90d38a40bca01f8d766b3342281", "wrong validated V4 commit")
    require(v4_wdg["update"]["size"] == 1_253_264, "wrong validated V4 artifact size")
    require(v4_wdg["update"]["sha256"] == "33fd2036a378fd44ea5035a52dff909f316c789aba7338e2aa63e6451e07885b", "wrong validated V4 artifact digest")
    require(v4_wdg["validation"] == {
        "label": "Physical V4 validation evidence",
        "url": "https://github.com/n30nex/Canadaverse-WDG-Mesh-Sidecar/blob/main/evidence/V4_HARDWARE_VALIDATION.md",
    }, "wrong V4 evidence link")
    require(all(profile["tag"] == "v1.0.0-rc.1" for device, profile in wdg_profiles if device["id"] != "heltec-v4"), "V3/RCC6 must remain on RC1")
    meshgangs_profiles = [
        (device, profile)
        for device in catalog["devices"]
        for profile in device["profiles"]
        if profile["id"] == "meshgangs-sidecar"
    ]
    require(len(meshgangs_profiles) == 1, "expected one launch-qualified MeshGangs profile")
    require({device["id"] for device, profile in meshgangs_profiles} == {"heltec-v3"}, "wrong MeshGangs hardware matrix")
    expected_meshgangs = {
        "heltec-v3": (
            "meshgangs-heltec-v3-v0.1.0-beta.21.bin",
            1_260_320,
            "ea2f26aca4fa4f7139b56f146fece01df0dae750065f6c1eebfa604f3bac8ee3",
            "42d8d71cf898ede009aa5338ee811c13",
        ),
    }
    for meshgangs_device, meshgangs in meshgangs_profiles:
        name, size, digest, md5 = expected_meshgangs[meshgangs_device["id"]]
        require(meshgangs["tag"] == "v0.1.0-beta.21", "wrong MeshGangs release")
        require(meshgangs["commit"] == "529d0fe253b80e8dd852f4b8f5073908d002fe33", "wrong MeshGangs source")
        require(meshgangs["update"]["address"] == 0x10000, "MeshGangs update must preserve NVS")
        require("recovery" not in meshgangs, "MeshGangs beta must be app-only")
        require(meshgangs["update"]["name"] == name, "wrong MeshGangs artifact name")
        require(meshgangs["update"]["size"] == size, "wrong MeshGangs artifact size")
        require(meshgangs["update"]["sha256"] == digest, "wrong MeshGangs artifact digest")
        require(meshgangs["update"]["md5"] == md5, "wrong MeshGangs write-verification digest")
        require(meshgangs["update"]["url"] == f"https://mg.canadaverse.org/downloads/files/{name}", "MeshGangs firmware must use its public download")
    for contract in (
        '#meshgangs-enroll=',
        'history.replaceState(null, "", `${location.pathname}${location.search}`)',
        'https://mg.canadaverse.org/api/v1/flasher/enroll',
        'credentials: "omit"',
        'referrerPolicy: "no-referrer"',
        'meshgangs.flasher-enrollment.v1',
        'payload.credential_kind !== expectedCredential',
        'secret: payload.credential',
        'CFG:MG1:USB',
        'CFG:MG1:WIFI:',
        'CFG:MG1:MOBILE:',
        'RSP:mgprovision:',
        'USB_READY',
        'MOBILE_READY',
        'meshgangs.desktop-enrollment.v1',
        'The radio never broadcasts a setup network or captive portal.',
    ):
        require(contract in html + js, f"missing MeshGangs USB setup contract: {contract}")
    require("payload.device_key" not in js, "flasher must receive only the role-scoped credential")
    require("payload.relay_key" not in js, "flasher must receive only the role-scoped credential")
    esp32_flow = js.split("async function flashEsp32", 1)[1].split(
        "async function flashUf2", 1
    )[0]
    require(
        esp32_flow.index("Wrong chip") < esp32_flow.index("enrollMeshGangsDevice")
        < esp32_flow.index("loader.writeFlash"),
        "MeshGangs enrollment must follow exact-chip verification and precede device writing",
    )
    boot_flow = js.split("async function verifyBoot", 1)[1].split(
        "function prepareOnboarding", 1
    )[0]
    require(
        boot_flow.index("provisionMeshGangs") < boot_flow.index("prepareOnboarding"),
        "MeshGangs USB role verification must precede onboarding",
    )
    select_device_flow = js.split("function selectDevice", 1)[1].split(
        "function renderProfiles", 1
    )[0]
    select_profile_flow = js.split("function selectProfile", 1)[1].split(
        "function updateContinueState", 1
    )[0]
    flash_selected_flow = js.split("async function flashSelected", 1)[1].split(
        "function downloadBytes", 1
    )[0]
    require(
        "resetMeshGangsDeviceWorkflow();" in select_device_flow
        and "resetMeshGangsDeviceWorkflow();" in select_profile_flow
        and "state.meshGangsProvisioned" in flash_selected_flow
        and "resetMeshGangsDeviceWorkflow();" in flash_selected_flow,
        "each new device workflow must clear prior MeshGangs provisioning state",
    )
    capture_handoff_flow = js.split("function captureMeshGangsEnrollment", 1)[1].split(
        "function saveMeshGangsHandoff", 1
    )[0]
    save_handoff_flow = js.split("function saveMeshGangsHandoff", 1)[1].split(
        "function isMeshGangsSidecar", 1
    )[0]
    require(
        "sessionStorage.removeItem(meshGangsHandoffKey)" in capture_handoff_flow
        and 'new URLSearchParams(location.search).get("role")' in capture_handoff_flow
        and "state.meshGangsRole = match &&" in capture_handoff_flow
        and "sessionStorage.setItem(meshGangsHandoffKey" in save_handoff_flow
        and "meshgangs-wifi-password" not in save_handoff_flow,
        "account handoff must preserve the chosen role without storing the Wi-Fi password",
    )
    meshgangs_html = html.split('id="meshgangs-setup"', 1)[1].split(
        'id="to-flash"', 1
    )[0] + html.split('id="meshgangs-onboarding"', 1)[1].split(
        'id="deskos-onboarding"', 1
    )[0]
    require("192.168.4.1" not in meshgangs_html, "MeshGangs setup must not mention a captive portal address")
    server = (ROOT / "deploy" / "server.py").read_text(encoding="utf-8")
    for header_contract in (
        '"Content-Security-Policy"',
        '"https://mg.canadaverse.org https://github.com "',
        '"https://release-assets.githubusercontent.com; frame-ancestors \'none\'; "',
        '"Cross-Origin-Opener-Policy", "same-origin"',
        '"Cross-Origin-Resource-Policy", "same-site"',
        "usb=(self), serial=(self)",
    ):
        require(header_contract in server, f"missing flasher security header: {header_contract}")
    ulp_profiles = [
        (device, profile)
        for device in catalog["devices"]
        for profile in device["profiles"]
        if profile["onboarding"] == "ulp-repeater"
    ]
    require(len(ulp_profiles) == 10, "expected ten ULP Solar Repeater profiles")
    require({device["id"] for device, profile in ulp_profiles} == {
        "heltec-v3", "heltec-v4", "rc52-server", "rcc6-server", "rak4631-ulp",
        "rak3401-1w-ulp", "xiao-esp32s3-ulp", "xiao-nrf52840-ulp",
    }, "wrong ULP hardware matrix")
    for device, profile in ulp_profiles:
        require(profile.get("tag", device["tag"]) == "v1.0.0-rc.2", f"wrong ULP release: {device['id']}")
        require(profile.get("commit", device["commit"]) == "f1ad326267618d03027a745258a2b5718d098d7d", f"wrong ULP source: {device['id']}")
        require("EasySkyMesh" in profile["features"], f"ULP attribution missing: {device['id']}")
        if device["flash_method"] == "esp32":
            require(profile["update"]["address"] == 0x10000, f"unsafe ULP update address: {device['id']}")
            require(profile["recovery"]["address"] == 0, f"wrong ULP recovery address: {device['id']}")
        else:
            require(profile["update"]["name"].endswith(".uf2"), f"nRF ULP update must be UF2: {device['id']}")
    for contract in ('id="ulp-profile"', 'value="on"', 'value="conservative"', 'value="max"', 'value="off"', "`ulp ${config.ulpProfile}`", "`gps advert ${config.ulpLocationPolicy}`", "do not create a Wi-Fi access point", "external MPPT/charge controller"):
        require(contract in html + js, f"missing ULP setup contract: {contract}")
    require("validation-evidence" in js, "V4 evidence is not rendered")
    require("flasher.js?v=20260823families1" in html, "flasher JS cache bust is stale")
    require("flasher.css?v=20260824boot1" in html, "flasher CSS cache bust is stale")
    require("scene.js?v=20260824boot1" in html, "scene JS cache bust is stale")
    require(".hero-orbit, .sidecar-promo" not in css, "Aircraft Sidecar download must remain visible")
    require("/assets/devices/${escapeHtml(device.id)}.svg" in js, "device cards must use hardware-specific SVGs")
    for device in catalog["devices"]:
        asset = ROOT / "assets" / "devices" / f"{device['id']}.svg"
        require(asset.is_file(), f"missing device silhouette: {asset.name}")
        svg = asset.read_text(encoding="utf-8")
        require("<svg" in svg and "<script" not in svg, f"unsafe device silhouette: {asset.name}")
    require(
        "WDG-Aircraft-Sidecar-Windows-x64-v1.1.0.zip" in html
        and "https://github.com/n30nex/WDG-Aircraft-Sidecar" in html,
        "WDG Aircraft Sidecar release links are missing",
    )
    for scene_contract in (
        "boot-sequence",
        "boot-meter",
        "scene-ticker",
        "scanline-drift",
        "ticker-scroll",
        "card-decode",
        "prefers-reduced-motion: reduce",
        "scene-canvas",
    ):
        require(scene_contract in html + css + scene_js, f"missing scene effect: {scene_contract}")
    require("pointer-events: none" in css, "scene canvas must not intercept flashing input")
    require("window.setTimeout(finishBoot, 820)" in scene_js, "quick boot timeout missing")
    require('addEventListener("pointerdown", finishBoot' in scene_js and 'addEventListener("keydown", finishBoot' in scene_js, "boot sequence must be skippable")
    require("pointermove" in scene_js and "pointerdown" in scene_js, "cursor trail or ripple missing")
    require("localStorage" not in js, "credentials/state must not be persistently stored")
    require(
        js.count("sessionStorage")
        == (capture_handoff_flow + save_handoff_flow).count("sessionStorage"),
        "session storage is limited to the non-secret account handoff",
    )
    print(f"Verified flasher: 13 devices, {profile_count} profiles, {len(artifacts)} exact artifacts")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
