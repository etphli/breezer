#!/usr/bin/env python3
"""Print Breezer build profile overrides or resolve a separate GN output path.

This command only reads paths and prints configuration. It never runs GN,
prepares source, or changes an existing build.
"""

import argparse
from pathlib import Path


PROFILES = ("upstream", "development", "release-performance", "pgo-performance")
DEVELOPMENT_ARGS = """is_official_build = false
chrome_pgo_phase = 0
symbol_level = 0
enable_precompiled_headers = false
"""


def gn_overrides(profile):
    if profile == "upstream":
        return ""
    if profile == "development":
        return DEVELOPMENT_ARGS
    if profile in ("release-performance", "pgo-performance"):
        # V8 debug code, cppgc API checks and allocator DCHECKs derive from
        # dcheck_always_on. Keep their release defaults instead of overriding
        # individual subsystems or security settings.
        overrides = DEVELOPMENT_ARGS + """is_debug = false
dcheck_always_on = false
enable_expensive_dchecks = false
"""
        return overrides + ("chrome_pgo_phase = 2\n" if profile == "pgo-performance" else "")
    raise ValueError(f"Unknown build profile: {profile}")


def output_directory(source, profile, requested=None):
    gn_overrides(profile)
    source = Path(source).resolve()
    output_root = (source / "out").resolve()
    default = {"release-performance": "out/ReleasePerformance", "pgo-performance": "out/PGOPerformance"}.get(profile, "out/Default")
    output = Path(requested or default)
    if not output.is_absolute():
        output = source / output
    output = output.resolve()
    if not output.is_relative_to(output_root) or output == output_root:
        raise ValueError("BREEZER_OUT_DIR must be a subdirectory of the prepared source's out directory.")
    preserved = ["out/Default"]
    if profile == "pgo-performance":
        preserved.append("out/ReleasePerformance")
    if profile in ("release-performance", "pgo-performance") and any(output.is_relative_to((source / path).resolve()) for path in preserved):
        raise ValueError(f"The {profile} profile requires a separate output; existing compiled outputs are preserved.")
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", choices=PROFILES, default="upstream")
    parser.add_argument("--source-dir", type=Path, help="Print the resolved output directory instead of GN overrides")
    parser.add_argument("--out-dir", help="Source-relative or absolute output path inside the source's out directory")
    args = parser.parse_args()
    if args.out_dir is not None and args.source_dir is None:
        parser.error("--out-dir requires --source-dir")
    try:
        if args.source_dir is not None:
            print(output_directory(args.source_dir, args.profile, args.out_dir))
        else:
            print(gn_overrides(args.profile), end="")
    except (OSError, ValueError) as error:
        parser.exit(1, f"Cannot select Breezer build output: {error}\n")


if __name__ == "__main__":
    main()
