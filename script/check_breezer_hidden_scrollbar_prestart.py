#!/usr/bin/env python3
"""Exercise actual scrollbar Init and bounds calls with controlled C++ doubles."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

from check_breezer_hidden_scrollbar import DATA, extract


def generate(source):
    native = source.read_text()
    header = (DATA / 'payload/rounded_scroll_bar.h').read_text()
    factory = next(line.strip() for line in header.splitlines()
                   if 'WeakPtrFactory<Thumb>' in line)
    methods = ('Thumb::Init', 'Thumb::OnBoundsChanged', 'Thumb::Show',
               'Thumb::Hide', 'Thumb::StartHideCountdown', 'SetIsAnimatingSize',
               'OnMouseEntered', 'OnMouseExited')
    reference_bytes = (DATA / 'reference-methods.json').read_bytes()
    provenance = json.loads((DATA / 'reference-methods-provenance.json').read_text())
    if hashlib.sha256(reference_bytes).hexdigest() != provenance['referenceMethodsSha256']:
        raise ValueError('Extracted reference methods changed')
    reference = json.loads(reference_bytes)
    text = (DATA / 'prestart_test.cc.in').read_text()
    for marker, value in {
        'THUMB': '\n\n'.join(extract(native, name) for name in methods),
        'VIEW': reference['view'], 'LAYER': reference['layer'],
        'ANIMATOR': reference['animator'], 'FACTORY': factory,
    }.items():
        text = text.replace('// @' + marker + '@', value)
    return text


def run(source, output, case=None):
    output.mkdir(parents=True, exist_ok=True)
    cpp = output / 'prestart_test.cc'
    cpp.write_text(generate(source))
    compiler = shutil.which('clang++') or shutil.which('c++')
    if compiler is None:
        raise ValueError('A C++20 compiler with ASan/UBSan is required')
    binary = output / 'prestart_test'
    command = [compiler, '-std=c++20', '-O1', '-g', '-Wall', '-Wextra',
               '-Werror', '-Wno-unused-parameter', '-fno-omit-frame-pointer',
               '-fsanitize=address,undefined', str(cpp), '-o', str(binary)]
    compiled = subprocess.run(command, capture_output=True, text=True, timeout=45)
    (output / 'compile.log').write_text(compiled.stdout + compiled.stderr)
    if compiled.returncode:
        raise ValueError('Fixture compile failed: ' + compiled.stderr)
    invoke = [str(binary), *([case] if case else [])]
    result = subprocess.run(invoke, capture_output=True, text=True, timeout=10)
    (output / 'run.log').write_text(result.stdout + result.stderr)
    (output / 'commands.json').write_text(json.dumps([command, invoke], indent=2) + '\n')
    print(result.stdout + result.stderr, end='')
    return result.returncode


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=DATA / 'payload/rounded_scroll_bar.cc')
    parser.add_argument('--output', type=Path)
    parser.add_argument('--case')
    args = parser.parse_args()
    if args.output:
        return run(args.source, args.output, args.case)
    with tempfile.TemporaryDirectory(prefix='breezer-scrollbar-prestart-') as directory:
        return run(args.source, Path(directory), args.case)


if __name__ == '__main__':
    raise SystemExit(main())
