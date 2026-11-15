#!/usr/bin/env python3
"""Compile actual scrollbar methods with bounded animator/timer doubles, offline.

This is a callback regression fixture, not a Views/widget/GPU integration test.
--source supports baseline red replay and failure controls without changing the
production payload. Generated C++ and compiler/run logs can be retained.
"""

import argparse
import hashlib
from pathlib import Path
import shutil
import subprocess
import tempfile
from unittest import mock

import apply_breezer_workspace as workspace

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / 'features/performance/hidden-scrollbar'
METHODS = ('Thumb::OnBoundsChanged', 'Thumb::Show', 'Thumb::Hide',
           'Thumb::StartHideCountdown', 'SetIsAnimatingSize',
           'OnMouseEntered', 'OnMouseExited')


def extract(source, name):
    start = source.index(f'void RoundedScrollBar::{name}(')
    body = source.index('{', start)
    depth = 1
    end = body + 1
    while depth:
        depth += (source[end] == '{') - (source[end] == '}')
        end += 1
    return source[start:end]


def check(source, output, case=None, quiet=False):
    content = source.read_bytes()
    methods = '\n\n'.join(extract(content.decode(), name) for name in METHODS)
    template = (DATA / 'callback_test.cc.in').read_text()
    output.mkdir(parents=True, exist_ok=True)
    fixture = output / 'callback_test.cc'
    fixture.write_text(template.replace('// @ACTUAL_METHODS@', methods))
    compiler = shutil.which('clang++') or shutil.which('c++')
    if compiler is None:
        raise ValueError('A local C++20 compiler is required')
    binary = output / 'callback_test'
    command = [compiler, '-std=c++20', '-O1', '-g', '-Wall', '-Wextra',
               '-Werror', '-Wno-unused-parameter', '-fno-omit-frame-pointer']
    command += ['-fsanitize=address,undefined']
    command += [str(fixture), '-o', str(binary)]
    result = subprocess.run(command, capture_output=True, text=True, timeout=45)
    (output / 'compile.log').write_text(result.stdout + result.stderr)
    (output / 'commands.txt').write_text('\n'.join((repr(command), repr([str(binary), *([case] if case else [])]))) + '\n')
    if result.returncode:
        raise ValueError('Fixture compile failed: ' + result.stderr)
    result = subprocess.run([str(binary), *([case] if case else [])],
                            capture_output=True, text=True, timeout=10)
    (output / 'run.log').write_text(result.stdout + result.stderr)
    (output / 'source.sha256').write_text(hashlib.sha256(content).hexdigest() + '\n')
    if not quiet:
        print(result.stdout + result.stderr, end='')
    return result.returncode


def preparation_checks(output):
    before, after = workspace.hidden_scrollbar_replacements()[0]
    # All other source bytes, including scroll/model/layout/drag and hover
    # methods, must remain identical to the licensed non-diagnostic baseline.
    restored = after.replace(extract(after, 'Thumb::OnBoundsChanged'),
                             extract(before, 'Thumb::OnBoundsChanged'), 1)
    restored = restored.replace('#include "base/memory/scoped_refptr.h"\n', '', 1)
    if restored != before:
        raise AssertionError('Scrollbar changes extend outside the callback and its include')
    for original in (before, after):
        if workspace.transform(workspace.HIDDEN_SCROLLBAR, original.encode()) != after.encode():
            raise AssertionError('Scrollbar preparation is not convergent')
    for drift in (before + '\n', after + '\n', '// diagnostic\n' + before,
                  after.replace('return true;', 'return false;', 1)):
        try:
            workspace.transform(workspace.HIDDEN_SCROLLBAR, drift.encode())
        except ValueError:
            pass
        else:
            raise AssertionError('Unknown donor accepted')
    with tempfile.TemporaryDirectory(prefix='breezer-scrollbar-preparation-') as directory:
        root = Path(directory)
        data = root / DATA.relative_to(ROOT)
        shutil.copytree(DATA, data)
        native = root / 'features/workspace/native'
        native.mkdir(parents=True)
        (native / 'unrelated.cc').write_text('preserve native input\n')
        (root / 'script').mkdir()
        for name in ('apply_breezer_workspace.py', 'breezer_sidebar_frame.py'):
            shutil.copyfile(ROOT / 'script' / name, root / 'script' / name)
        with mock.patch.multiple(workspace, ROOT=root, NATIVE=native, HIDDEN_SCROLLBAR_DATA=data):
            identity = workspace.fingerprint()
            for name in ('pins.json', 'baseline/rounded_scroll_bar.cc', 'payload/rounded_scroll_bar.cc'):
                path = data / name
                saved = path.read_bytes()
                path.write_bytes(saved + b'\n')
                if workspace.fingerprint() == identity:
                    raise AssertionError('Scrollbar input missing from workspace fingerprint: ' + name)
                try:
                    workspace.hidden_scrollbar_replacements()
                except ValueError:
                    if name == 'pins.json':
                        raise
                else:
                    if name != 'pins.json':
                        raise AssertionError('Corrupted payload/baseline pin accepted')
                path.write_bytes(saved)
            if workspace.fingerprint() != identity:
                raise AssertionError('Fingerprint failed to recover')
        # Exercise the real writer on a fresh minimal source tree. The full
        # workspace fixture separately checks all other upstream targets.
        tree = root / 'source'
        target = tree / workspace.HIDDEN_SCROLLBAR
        target.parent.mkdir(parents=True)
        target.write_bytes(before.encode())
        sentinel = tree / 'out/compiled-cache'
        sentinel.parent.mkdir()
        sentinel.write_bytes(b'preserve compiled output')
        with mock.patch.multiple(workspace,
                                 replacements=lambda: {workspace.HIDDEN_SCROLLBAR: [(before, after)]},
                                 added_files=lambda: {}):
            try:
                workspace.apply(tree, check=True)
            except ValueError:
                pass
            else:
                raise AssertionError('Check accepted an unapplied scrollbar')
            if target.read_bytes() != before.encode():
                raise AssertionError('Check wrote the source')
            if workspace.apply(tree) != 1 or target.read_bytes() != after.encode():
                raise AssertionError('Fresh source was not prepared')
            if workspace.apply(tree) != 0 or workspace.apply(tree, check=True) != 0:
                raise AssertionError('Writer replay was not idempotent')
            target.write_bytes(before.encode() + b'// drift\n')
            try:
                workspace.apply(tree)
            except ValueError:
                pass
            else:
                raise AssertionError('Writer accepted unknown donor')
            if target.read_bytes() != before.encode() + b'// drift\n':
                raise AssertionError('Drift failure wrote the source')
        if sentinel.read_bytes() != b'preserve compiled output':
            raise AssertionError('Preparation modified compiled output')
    message = 'PASS: exact donor/payload pins, idempotent transform, donor drift rejection, unchanged non-callback source, preparation fingerprint inputs.\n'
    output.mkdir(parents=True, exist_ok=True)
    (output / 'preparation.log').write_text(message)
    print(message, end='')


def failure_controls(output):
    """Small actual-method mutants must fail their targeted callback case."""
    source = (DATA / 'payload/rounded_scroll_bar.cc').read_text()
    bounds = '    animator->StopAnimatingProperty(ui::LayerAnimationElement::BOUNDS);\n'
    opacity = '    animator->StopAnimatingProperty(ui::LayerAnimationElement::OPACITY);\n'
    timer = '    hide_timer_.Stop();\n'
    mutations = (
        ('missing-bounds-stop', source.replace(bounds, '', 1), 'hidden-bounds'),
        ('missing-opacity-stop', source.replace(opacity, '', 1), 'hidden-bounds-opacity'),
        ('missing-timer-stop', source.replace(timer, '', 1), 'hidden-no-animation'),
        ('late-timer-stop', source.replace(timer, '', 1).replace(opacity, opacity + timer, 1),
         'completion-destroys-view'),
        ('missing-retain', source.replace('scoped_refptr<ui::LayerAnimator> animator =',
                                         'ui::LayerAnimator* animator =', 1),
         'completion-destroys-view'),
        ('global-stop', source.replace(bounds + opacity, '    animator->StopAnimating();\n', 1),
         'hidden-bounds-opacity'),
    )
    results = []
    for name, content, case in mutations:
        directory = output / name
        directory.mkdir(parents=True, exist_ok=True)
        mutant = directory / 'rounded_scroll_bar.cc'
        mutant.write_text(content)
        status = check(mutant, directory, case, quiet=True)
        log = (directory / 'run.log').read_text()
        if status == 0:
            raise AssertionError('Failure control incorrectly passed: ' + name)
        if name == 'missing-retain' and 'heap-use-after-free' not in log:
            raise AssertionError('Missing retain control did not detect use-after-free')
        results.append(f'PASS {name}: targeted regression rejected, exit {status}')
    (output / 'controls.log').write_text('\n'.join(results) + '\n')
    print('\n'.join(results))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=DATA / 'payload/rounded_scroll_bar.cc')
    parser.add_argument('--output', type=Path)
    parser.add_argument('--case')
    parser.add_argument('--failure-controls', action='store_true',
                        help='Also compile six small deliberately broken callbacks')
    args = parser.parse_args()
    def run(output):
        preparation_checks(output)
        result = check(args.source, output, args.case)
        if args.failure_controls:
            failure_controls(output / 'failure-controls')
        return result
    if args.output:
        return run(args.output)
    with tempfile.TemporaryDirectory(prefix='breezer-scrollbar-') as directory:
        return run(Path(directory))


if __name__ == '__main__':
    raise SystemExit(main())
