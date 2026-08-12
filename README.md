# NeonPocketMC Flasher

Guided browser flashing and USB onboarding for the [NeonPocketMC firmware suite](https://github.com/n30nex/NeonPocketMC).

**Production:** [flasher.canadaverse.org](https://flasher.canadaverse.org/)

## What it does

1. Selects the exact Heltec V3, V4, RadioCore RC52, or RadioCore RCC6 hardware.
2. Selects a released companion, repeater, observer, or Room Server profile.
3. Verifies the exact release file with SHA-256 before touching USB.
4. Detects ESP32-C6 versus ESP32-S3 in ROM and blocks the wrong family.
5. Writes ESP application-only updates at `0x10000`, or an explicitly selected recovery image at `0x0`.
6. Reads the written ESP range back through the ROM MD5 command and compares it with the deployed manifest.
7. Identifies RC52 by USB VID/PID and writes the verified application UF2 through its existing bootloader drive.
8. Requires the expected USB device to return after restart.
9. Runs a profile-aware 115200-baud USB wizard for name, legal radio preset, TX power, repeat mode, three-byte hashes, local passwords, Wi-Fi, and built-in MQTT presets.
10. Reboots server profiles, verifies saved settings, and reports the LAN IP before USB is disconnected.

No password is saved by the page, browser storage, repository, or server. Secret CLI commands are redacted from the visible console.

## Supported released profiles

- Heltec V3 / V4 BLE companion with OLED
- RC52 BLE companion with NV3001B TFT
- RC52 headless repeater
- RC52 Room Server, headless or TFT
- RCC6 Ultimate BLE companion with TFT
- RCC6 Ultimate Wi-Fi/Web companion with TFT
- RCC6 MQTT observer/repeater with WebUI
- RCC6 Room Server minimal/full, headless/TFT

Normal updates preserve bootloader, partitions, identity, contacts, channels, and settings. Recovery images are an explicit expert path: they replace the boot/partition regions and may reset NVS/BLE bonds even when MeshCore storage is preserved.

## Browser requirements

Use current desktop Chrome or Edge over HTTPS. Web Serial is not available in Firefox or iOS browsers. Keep a tuned LoRa antenna attached before transmitting.

For RC52, double-press Reset when instructed and select the bootloader drive containing `INFO_UF2.TXT`. The site copies only the application UF2; it does not replace the SoftDevice or bootloader.

## Development

The site is deliberately static. It uses the vendored ESPTool-JS bundle inherited from the MIT-licensed [agessaman flasher](https://github.com/agessaman/flasher.meshcore.io) and native browser APIs. There is no frontend framework, server-side credential path, or browser compiler.

```powershell
python scripts\verify_site.py
node --check flasher.js
python -m http.server 8877 --bind 127.0.0.1
```

`profiles.json` owns product/profile behavior. `catalog.json` is the exact deployed release snapshot. The Pages workflow refreshes the unified suite catalog, downloads every selected image, verifies size and SHA-256, calculates the flash MD5, then publishes firmware and catalog together on the same origin.

## License and attribution

MIT. This repository began from `agessaman/flasher.meshcore.io` and retains its MIT license and copyright notice. NeonPocketMC additions are copyright n30nex/Canadaverse contributors. MeshCore and Heltec are independent projects; this is community firmware and not an official service of either project.
