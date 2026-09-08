#!/usr/bin/env python3
"""Download exact catalog artifacts into a same-origin static firmware folder."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from urllib.request import Request, urlopen


def sha256(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--suite", required=True)
    parser.add_argument("--profiles")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    suite = json.loads(Path(args.suite).read_text(encoding="utf-8"))
    products = {product["id"]: product for product in suite["products"]}
    if args.profiles:
        profiles = json.loads(Path(args.profiles).read_text(encoding="utf-8"))
        products.update({product["id"]: product for product in profiles.get("products", [])})
    args.output.mkdir(parents=True, exist_ok=True)

    for product in products.values():
        for artifact in product["artifacts"]:
            name = artifact["name"]
            if not name.endswith((".bin", ".uf2")):
                continue
            target = args.output / name
            if target.is_file() and target.stat().st_size == artifact["size"] and sha256(target) == artifact["sha256"]:
                print(f"verified {name}")
                continue
            partial = target.with_suffix(target.suffix + ".part")
            request = Request(artifact["url"], headers={"User-Agent": "NeonPocketMC-Flasher/1"})
            with urlopen(request, timeout=120) as response, partial.open("wb") as output:
                while chunk := response.read(1024 * 1024):
                    output.write(chunk)
            if partial.stat().st_size != artifact["size"] or sha256(partial) != artifact["sha256"]:
                partial.unlink(missing_ok=True)
                raise SystemExit(f"download verification failed: {name}")
            partial.replace(target)
            print(f"downloaded {name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
