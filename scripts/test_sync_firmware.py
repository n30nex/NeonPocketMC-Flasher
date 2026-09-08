"""Check that downloads use the same product overrides as catalog generation."""

from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
import tempfile
from unittest.mock import patch

import sync_firmware


def main():
    payloads = {"https://example.invalid/current.bin": b"current firmware",
                "https://example.invalid/kept.uf2": b"unchanged firmware"}

    def artifact(name, payload):
        return {"name": name, "url": "https://example.invalid/" + name,
                "size": len(payload), "sha256": sha256(payload).hexdigest()}

    with tempfile.TemporaryDirectory() as folder:
        root = Path(folder)
        old = {"id": "updated", "artifacts": [artifact("retired.bin", b"retired")]}
        current = {"id": "updated", "artifacts": [artifact("current.bin", payloads["https://example.invalid/current.bin"])]}
        kept = {"id": "kept", "artifacts": [artifact("kept.uf2", payloads["https://example.invalid/kept.uf2"])]}
        (root / "suite.json").write_text(json.dumps({"products": [old, kept]}))
        (root / "profiles.json").write_text(json.dumps({"products": [current]}))
        args = ["sync_firmware.py", "--suite", str(root / "suite.json"),
                "--profiles", str(root / "profiles.json"), "--output", str(root / "out")]
        with patch("sys.argv", args), patch.object(sync_firmware, "urlopen") as fetch:
            fetch.side_effect = lambda request, **_kwargs: BytesIO(payloads[request.full_url])
            assert sync_firmware.main() == 0
            assert {call.args[0].full_url for call in fetch.call_args_list} == set(payloads)
            assert {path.name for path in (root / "out").iterdir()} == {"current.bin", "kept.uf2"}
            fetch.reset_mock()
            assert sync_firmware.main() == 0
            fetch.assert_not_called()
    print("PASS: current overrides replace retired downloads; other products and verified cache are preserved")


if __name__ == "__main__":
    main()
