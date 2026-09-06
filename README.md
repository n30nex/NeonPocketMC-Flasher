# NeonPocketMC Flasher

Guided browser flashing and USB onboarding for the [NeonPocketMC firmware suite](https://github.com/n30nex/NeonPocketMC).

**Production:** [flasher.canadaverse.org](https://flasher.canadaverse.org/)

## What it does

1. Selects the exact Heltec V3/V4, RAK4631, RAK3401 1 W, Xiao ESP32-S3/nRF52840, RadioCore RC52/RCC6, or SenseCAP Indicator D1L hardware.
2. Selects a released companion, repeater, ULP Solar Repeater, observer, Room Server, WDG Mesh Sidecar, or MeshGangs Territory Sidecar profile.
3. Verifies the exact release file with SHA-256 before touching USB.
4. Detects ESP32-C6 versus ESP32-S3 in ROM and blocks the wrong family.
5. Writes each ESP image at its release-owned address: `0x10000` for NeonPocket and WDG Sidecar updates, `0x20000` for DeskOS updates, or `0x0` for an explicitly selected recovery/clean image.
6. Reads the written ESP range back through the ROM MD5 command and compares it with the deployed manifest.
7. Identifies RC52 by USB VID/PID and writes the verified application UF2 through its existing bootloader drive.
8. Requires the expected USB device to return after restart; DeskOS must also report the exact release commit and healthy board, UI, and storage state.
9. Runs a profile-aware 115200-baud USB wizard for name, legal radio preset, TX power, repeat mode, three-byte hashes, local passwords, Wi-Fi, MQTT presets, and ULP power profile.
10. Reboots server profiles, verifies saved settings, and reports the LAN IP before USB is disconnected.
11. Installs the separately verified DeskOS RP2040 bridge through an explicit BOOTSEL-drive picker, then verifies bridge readiness from DeskOS.
12. Prepares an existing FAT32 DeskOS SD card by adding only missing, checksum-verified files and folders; it refuses to replace different files and never formats or deletes content.

No password is saved by the page, browser storage, repository, or server. Secret CLI commands are redacted from the visible console.

## Supported released profiles

- Heltec V3 / V4 BLE and native-USB companions, Ultimate BLE/Web companions, and Ultimate WebUI repeaters with OLED
- RC52 BLE or native-USB companion with NV3001B TFT
- RC52 screenless BLE companion with fixed pairing PIN `123456`
- RC52 headless repeater
- RC52 Room Server, headless or TFT
- RCC6 Ultimate BLE or native-USB companion with TFT
- RCC6 Ultimate Wi-Fi/Web companion with TFT
- RCC6 screenless BLE, native-USB, or Wi-Fi Web/TCP companion
- RCC6, Heltec V3, and Heltec V4 WDG Mesh Sidecar for Biscuit-compatible live MeshCore collection (V4 RC2 physically validated with public evidence)
- Heltec V3 MeshGangs Signal Frontiers Beta 23 sidecar with USB-only role setup, privacy-safe live-only relay, and authenticated Android patrol pairing; Beta 22 remains selectable as an app-only rollback
- RCC6 MQTT observer/repeater with WebUI
- RCC6 Room Server minimal/full, headless/TFT
- Experimental ULP Solar Repeater builds for V3, V4, RAK4631, RAK3401 1 W, Xiao ESP32-S3, Xiao nRF52840, and headless/TFT RCC6/RC52
- SenseCAP Indicator D1L DeskOS touch companion, including safe update, deliberate fresh install, RP2040 bridge setup, and non-destructive SD preparation

Normal updates preserve bootloader, partitions, identity, contacts, channels, and settings. DeskOS updates verify the application before writing and verifying its boot selection, so USB updates also work after a signed SD update used the alternate application slot. Recovery images are an explicit expert path: they replace the boot/partition regions and may reset NVS/BLE bonds even when MeshCore storage is preserved. The D1L full 8 MB image requires separate confirmation because it replaces all ESP32 flash data, including identity and settings; SD files remain on the card. A clean D1L install has three required stages: ESP32 firmware, RP2040 SD bridge, and a prepared FAT32 card. The web wizard remains incomplete until DeskOS verifies all three; flashing only the ESP32 cannot enable the SD slot.

DeskOS **1.8.0-rc.1** is the current release candidate. It improves radio timing and diagnostics, loading progress, and map labels. The browser reads real DeskOS JSON, waits for startup over one USB connection, and verifies the display, identity, radio, and nested SD status. Preserving updates can finish without optional SD storage; fresh installs retain the complete setup. Hardware/build choices stay locked while flashing, and verification is invalidated when the selection changes.

The complete package, signed SD update, installation guide, and previous stable **1.7.12** remain linked from the D1L build card. An unresolved retained-storage fault is shown explicitly and cannot count as a ready SD stage. Builds and checks run locally on the Pi 5. Official Android app 1.49.0 interoperability was verified on 1.7.12; the candidate release notes identify the physical tests actually run. Wi-Fi and Bluetooth remain selectable exclusive modes.

The WDG Mesh Sidecar profile is deliberately live-only. It has no WiGLE import, historical scan, stored upload backlog, catch-up, migration, or backfill path. After flashing, use the device's temporary setup Wi-Fi to store a 2.4 GHz hotspot and WDGWars API key directly on the device; the flasher does not receive or store either credential.

The MeshGangs profiles are separate app-only Heltec V3 and original V4 Home releases with no captive portal or setup access point. An authenticated, ten-minute handoff from `mg.canadaverse.org` lets the flasher create one key and configure exactly one role over USB: Home USB (the desktop uploader owns the device key), Home Wi-Fi (the radio owns the device key and 2.4 GHz network details), or Mobile BLE (the radio receives only a scoped relay key while Android supplies GPS and internet). Enrollment secrets remain in the tab only until USB verification finishes; Home USB can export its one-time desktop setup file. Collection is live-only: a small volatile in-flight buffer exists only while the configured uplink is active and is discarded on disconnect or restart. No message text or raw packets are accepted. Android patrol pairing requires the random six-digit code shown on the V3. Original V4/V4.3 Beta 24 supports Home USB and Home Wi-Fi only. Before enrollment or writing, its flash gate requires native USB, 2 MB PSRAM, 16 MB flash and a compatible application partition. V4 R8 is excluded. The restarted V4 must identify the selected product/version before receiving credentials.

## Browser requirements

Use current desktop Chrome or Edge over HTTPS. Web Serial is not available in Firefox or iOS browsers. Keep a tuned LoRa antenna attached before transmitting.

Heltec V3 connects through its Silicon Labs CP2102 USB-to-UART bridge. On macOS, if the V3 does not appear in the Chrome or Edge port chooser, install the current [CP210x VCP driver](https://www.silabs.com/developer-tools/usb-to-uart-bridge-vcp-drivers?tab=downloads), reconnect the board with a data-capable cable, and close any app already using the serial port.

For RC52, double-press Reset when instructed and select the bootloader drive containing `INFO_UF2.TXT`. The site copies only the application UF2; it does not replace the SoftDevice or bootloader.

ULP Solar Repeater builds start new installs in the balanced EasySkyMesh power profile. The wizard can select balanced, conservative, maximum-saving, or continuous receive and verifies it after reboot. RX duty cycling can miss packets. Solar hardware still needs a protected battery and an external MPPT/charge controller matched to the panel and cell.

ULP repeaters are configured over USB. They do not create a setup access point or WebUI. The wizard can keep or update the saved map coordinates and explicitly verifies whether that location is included in adverts.

For the D1L RP2040 bridge, hold BOOTSEL while reconnecting the RP2040 USB side, then select the drive containing `INFO_UF2.TXT`. Reconnect the ESP32 side and use **Verify bridge** afterward. For SD setup, select the root of an already-formatted FAT32 microSD card. Both workflows are additive and never format the card.

## Development

The site is deliberately static. It uses the vendored ESPTool-JS bundle inherited from the MIT-licensed [agessaman flasher](https://github.com/agessaman/flasher.meshcore.io) and native browser APIs. There is no frontend framework, server-side credential path, or browser compiler.

```powershell
python scripts\verify_site.py
node --check flasher.js
node scripts/test_meshgangs_v4.cjs
node scripts/test_meshgangs_serial.cjs
node scripts/test_deskos_flash.cjs
node scripts/test_deskos_console.cjs
python -m http.server 8877 --bind 127.0.0.1
```

`profiles.json` owns product/profile behavior. `catalog.json` is the exact deployed release snapshot. The packaging workflow refreshes the unified suite catalog, downloads every selected image once to verify size/SHA-256 and calculate flash MD5, then emits a small Pi bundle without firmware binaries.

Production runs on the Canadaverse Pi 5 behind the existing Cloudflare Tunnel. Firmware stays in the product GitHub releases; the Pi streams only catalog-pinned release assets through a same-origin endpoint so the browser can verify SHA-256 before writing and MD5 after writing. The container listens on the internal Docker network at port 8080 and is reached publicly as `https://flasher.canadaverse.org`.

For V3, V4, and RCC6 companion Web builds, the LAN WebUI login is `meshcore` plus the eight-letter device key shown before restart. The device key is not the home Wi-Fi password. Headless RCC6 prints both the key and LAN IP in the 115200-baud serial console.

## License and attribution

MIT. This repository began from `agessaman/flasher.meshcore.io` and retains its MIT license and copyright notice. NeonPocketMC ULP profiles use and attribute IoTThinks' EasySkyMesh power-saving work. NeonPocketMC additions are copyright n30nex/Canadaverse contributors. MeshCore, EasySkyMesh, and the hardware vendors are independent projects; this is not an official service of any of them.
