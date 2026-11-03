#!/usr/bin/env python3
"""Verify the tested modules after packaging the private Breezer host."""
import argparse
import json
from pathlib import Path
from package_breezer_ai import verify_memory_host as verify


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app', type=Path, required=True)
    parser.add_argument('--packet', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(verify(args.app, args.packet), indent=2))


if __name__ == '__main__':
    main()
