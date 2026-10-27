#!/usr/bin/env python3
"""Create a verified, compressed Breezer disk image from an existing app."""

import argparse
import hashlib
import os
from pathlib import Path
import platform
import subprocess
import sys
import tempfile

import install_breezer


def resolve_paths(app_argument, output_argument):
    app_input = Path(app_argument).expanduser()
    if app_input.is_symlink():
        raise ValueError("The app path must point directly to a real Breezer.app directory.")
    try:
        app = app_input.resolve(strict=True)
    except OSError as error:
        raise ValueError(f"The app path does not exist: {app_input}") from error
    if app.name != "Breezer.app" or not app.is_dir():
        raise ValueError("The input must be a real Breezer.app directory.")

    output_input = Path(output_argument).expanduser()
    if not output_input.is_absolute():
        output_input = Path.cwd() / output_input
    if output_input.suffix.lower() != ".dmg" or output_input.name in ("", ".", ".."):
        raise ValueError("The output file must have a .dmg extension.")
    try:
        parent = output_input.parent.resolve(strict=True)
    except OSError as error:
        raise ValueError(f"The output directory must already exist: {output_input.parent}") from error
    if not parent.is_dir():
        raise ValueError(f"The output parent is not a directory: {parent}")
    output = parent / output_input.name
    checksum = Path(str(output) + ".sha256")

    if os.path.lexists(output):
        raise ValueError(f"Refusing to overwrite an existing output: {output}")
    if os.path.lexists(checksum):
        raise ValueError(f"Refusing to overwrite an existing checksum: {checksum}")
    if output == app or output.is_relative_to(app):
        raise ValueError("The DMG and checksum must be outside Breezer.app.")
    return app, output, checksum


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def package(app_argument, output_argument, verify_app=install_breezer.verify_app):
    if platform.system() != "Darwin":
        raise ValueError("DMG packaging requires macOS.")
    for executable in ("/usr/bin/ditto", "/usr/bin/hdiutil"):
        if not Path(executable).is_file():
            raise ValueError(f"Required macOS tool is missing: {executable}")

    app, output, checksum = resolve_paths(app_argument, output_argument)
    verify_app(app)

    # Keep staging and the image on the output volume so final links are atomic.
    with tempfile.TemporaryDirectory(prefix=".breezer-dmg-", dir=output.parent) as temporary:
        work = Path(temporary)
        image_root = work / "image-root"
        image_root.mkdir()
        staged_app = image_root / "Breezer.app"
        subprocess.run(["/usr/bin/ditto", str(app), str(staged_app)], check=True)
        (image_root / "Applications").symlink_to("/Applications")
        verify_app(staged_app)

        image = work / "Breezer.dmg"
        subprocess.run([
            "/usr/bin/hdiutil", "create", "-volname", "Breezer",
            "-srcfolder", str(image_root), "-format", "UDZO",
            "-imagekey", "zlib-level=9", str(image),
        ], check=True)
        subprocess.run(["/usr/bin/hdiutil", "verify", str(image)], check=True)

        checksum_temp = work / "Breezer.dmg.sha256"
        checksum_temp.write_text(f"{sha256(image)}  {output.name}\n", encoding="utf-8")

        # Hard links create each final file without replacing a path created by
        # another process after the initial existence check.
        image_published = False
        try:
            os.link(image, output)
            image_published = True
            os.link(checksum_temp, checksum)
        except BaseException:
            if image_published:
                output.unlink(missing_ok=True)
            raise

    print(f"Created verified Breezer disk image: {output}")
    print(f"SHA-256 checksum: {checksum}")
    return output, checksum


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("app", type=Path, help="Existing real Breezer.app directory")
    parser.add_argument("output", type=Path, help="New .dmg path; the parent directory must exist")
    args = parser.parse_args()
    package(args.app, args.output)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        detail = (
            error.stderr.strip()
            if isinstance(error, subprocess.CalledProcessError) and error.stderr
            else str(error)
        )
        print(f"Breezer DMG: {detail}", file=sys.stderr)
        sys.exit(1)
