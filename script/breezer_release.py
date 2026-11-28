"""Read the release identity shared by the extension and native packaging."""

import json
from pathlib import Path
import re


def release_version(root):
    extension = Path(root) / 'features/ai/extension'
    return parse_release_version(
        (extension / 'release-info.js').read_text(),
        (extension / 'manifest.json').read_text(),
    )


def parse_release_version(source, manifest):
    versions = re.findall(r"^export const RELEASE_VERSION = '((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))';$", source, re.M)
    if len(versions) != 1:
        raise ValueError('Expected one plain release version in release-info.js.')
    version = versions[0]
    if json.loads(manifest).get('version') != version:
        raise ValueError('Extension manifest and release-info.js versions differ.')
    return version
