#!/usr/bin/env python3
"""Run every imported Python test and the source configuration checks."""

import json
from pathlib import Path
import subprocess
import sys


ROOT = Path(__file__).resolve().parent.parent
LOCK = json.loads((ROOT / "upstream.lock.json").read_text())
CORE = ROOT / LOCK["helium"]["path"]
PLATFORM = ROOT / LOCK["helium_macos"]["path"]


def main():
    checks = [
        ("Helium utility tests", ["-m", "pytest", "-c", "pytest.ini"], CORE / "utils"),
        ("Helium development-tool tests", ["-m", "pytest", "-c", "pytest.ini"], CORE / "devutils"),
        ("Helium configuration", [str(CORE / "devutils/validate_config.py")], CORE),
        ("macOS patch series", [str(CORE / "devutils/check_patch_files.py"), "-p", str(PLATFORM / "patches")], PLATFORM),
    ]
    failures = []
    for name, arguments, directory in checks:
        print(f"\nRunning {name}", flush=True)
        result = subprocess.run([sys.executable, *arguments], cwd=directory)
        if result.returncode:
            failures.append(name)
    if failures:
        print("Failed checks: " + ", ".join(failures), file=sys.stderr)
        return 1
    print("All imported tests and configuration checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
