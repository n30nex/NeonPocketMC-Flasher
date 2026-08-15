#!/usr/bin/env python3
"""Merge the unified suite catalog with flasher-specific profile metadata."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from urllib.request import urlopen


def load_json(source: str) -> dict:
    if source.startswith(("http://", "https://")):
        with urlopen(source, timeout=30) as response:
            return json.load(response)
    return json.loads(Path(source).read_text(encoding="utf-8"))


def digest(path: Path, algorithm: str) -> str:
    hasher = hashlib.new(algorithm)
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--suite", required=True, help="Unified catalog file or URL")
    parser.add_argument("--profiles", default="profiles.json")
    parser.add_argument("--output", default="catalog.json")
    parser.add_argument("--firmware-dir", type=Path)
    parser.add_argument("--firmware-base", default="/firmware/")
    args = parser.parse_args()

    suite = load_json(args.suite)
    profiles = load_json(args.profiles)
    products = {product["id"]: product for product in suite["products"]}
    for product in profiles.get("products", []):
        products[product["id"]] = product
    result = {
        "schema": 1,
        "suite_version": suite["suite_version"],
        "devices": [],
        "radio_presets": profiles["radio_presets"],
        "mqtt_presets": profiles["mqtt_presets"],
    }

    for device in profiles["devices"]:
        product = products.get(device["product"])
        if not product:
            raise SystemExit(f"missing suite product: {device['product']}")
        output_device = {key: value for key, value in device.items() if key != "profiles"}
        output_device.update({
            "repository": product["repository"],
            "release": product["release"],
            "tag": product["tag"],
            "commit": product["commit"],
            "profiles": [],
        })
        for profile in device["profiles"]:
            profile_product = products.get(profile.get("product", device["product"]))
            if not profile_product:
                raise SystemExit(
                    f"missing profile product for {device['id']}/{profile['id']}"
                )
            profile_artifacts = {
                artifact["name"]: artifact
                for artifact in profile_product["artifacts"]
            }
            output_profile = dict(profile)
            if profile_product["id"] != product["id"]:
                output_profile.update({
                    "repository": profile_product["repository"],
                    "release": profile_product["release"],
                    "tag": profile_product["tag"],
                    "commit": profile_product["commit"],
                })
            for kind in ("update", "recovery", "bridge"):
                name = profile.get(kind)
                if not name:
                    continue
                artifact = profile_artifacts.get(name)
                if not artifact:
                    raise SystemExit(f"missing artifact {name} for {device['id']}/{profile['id']}")
                output_artifact = dict(artifact)
                address = profile.get(f"{kind}_address")
                if address is not None:
                    output_artifact["address"] = address
                if args.firmware_dir:
                    path = args.firmware_dir / name
                    if not path.is_file():
                        raise SystemExit(f"missing staged firmware: {path}")
                    if path.stat().st_size != artifact["size"]:
                        raise SystemExit(f"size mismatch: {path}")
                    if digest(path, "sha256") != artifact["sha256"]:
                        raise SystemExit(f"SHA-256 mismatch: {path}")
                    output_artifact["md5"] = digest(path, "md5")
                    output_artifact["local_url"] = (
                        args.firmware_base.rstrip("/")
                        + "/"
                        + artifact["sha256"]
                        + "/"
                        + name
                    )
                output_profile[kind] = output_artifact
                output_profile.pop(f"{kind}_address", None)
            output_device["profiles"].append(output_profile)
        result["devices"].append(output_device)

    with Path(args.output).open("w", encoding="utf-8", newline="\n") as output:
        output.write(json.dumps(result, indent=2) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
