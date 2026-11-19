#!/usr/bin/env python3
"""Compile actual scrollbar methods with bounded animator/timer doubles, offline.

This is a callback regression fixture, not a Views/widget/GPU integration test.
--source supports baseline red replay and failure controls without changing the
production payload. Generated C++ and compiler/run logs can be retained.
"""

import argparse
from concurrent.futures import ThreadPoolExecutor
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
    # Native changes are limited to the hidden callback, its Init animator and
    # two includes. Full files are independently pinned by the workspace hook.
    before, after = workspace.hidden_scrollbar_replacements()[0]
    restored = after
    for method in ('Thumb::OnBoundsChanged', 'Thumb::Init'):
        restored = restored.replace(extract(after, method), extract(before, method), 1)
    for name in ('base/memory/scoped_refptr.h', 'ui/compositor/layer_animation_delegate.h'):
        restored = restored.replace(f'#include "{name}"\n', '', 1)
    if restored != before:
        raise AssertionError('Scrollbar changes extend outside the scoped methods/includes')
    old_header, header = workspace.hidden_scrollbar_replacements(workspace.HIDDEN_SCROLLBAR_HEADER)[0]
    if header.replace('#include "base/memory/weak_ptr.h"\n', '', 1).replace(
            '    base::WeakPtrFactory<Thumb> weak_ptr_factory_{this};\n', '', 1) != old_header:
        raise AssertionError('Unexpected scrollbar header change')
    for name in (workspace.HIDDEN_SCROLLBAR, workspace.HIDDEN_SCROLLBAR_HEADER):
        choices = workspace.hidden_scrollbar_replacements(name)
        for donor in [a for a, _ in choices] + [choices[0][1]]:
            if workspace.transform(name, donor.encode()) != choices[0][1].encode():
                raise AssertionError('Non-convergent native transform')
            try:
                workspace.transform(name, (donor + '\n').encode())
            except ValueError:
                pass
            else:
                raise AssertionError('Unknown full source accepted')
    with tempfile.TemporaryDirectory(prefix='breezer-scrollbar-preparation-') as directory:
        root = Path(directory)
        data = root / DATA.relative_to(ROOT)
        shutil.copytree(DATA, data)
        native = root / 'features/workspace/native'
        native.mkdir(parents=True)
        (native / 'unrelated.cc').write_text('preserve native input\n')
        (root / 'script').mkdir()
        for name in ('apply_breezer_workspace.py', 'breezer_sidebar_frame.py', 'breezer_tab_groups.py'):
            shutil.copyfile(ROOT / 'script' / name, root / 'script' / name)
        with mock.patch.multiple(workspace, ROOT=root, NATIVE=native, HIDDEN_SCROLLBAR_DATA=data):
            identity = workspace.fingerprint()
            for path in sorted(p for p in data.rglob('*') if p.is_file()):
                saved = path.read_bytes()
                path.write_bytes(saved + b'\n')
                if workspace.fingerprint() == identity:
                    raise AssertionError('Fingerprint omitted ' + str(path))
                path.write_bytes(saved)
            if workspace.fingerprint() != identity:
                raise AssertionError('Fingerprint failed to recover')
            for name in (workspace.HIDDEN_SCROLLBAR, workspace.HIDDEN_SCROLLBAR_HEADER):
                row = __import__('json').loads((data / 'pins.json').read_text())['files'][name]
                for key in ('baseline', 'payload'):
                    path = data / row[key]
                    saved = path.read_bytes()
                    path.write_bytes(saved + b'\n')
                    try:
                        workspace.hidden_scrollbar_replacements(name)
                    except ValueError:
                        pass
                    else:
                        raise AssertionError('Corrupt full-file input accepted')
                    path.write_bytes(saved)
    output.mkdir(parents=True, exist_ok=True)
    message = 'PASS: native cc/header pins, previous donor migration, idempotence, source scope, drift rejection and fingerprints.\n'
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

    def run_control(mutation):
        name, content, case = mutation
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
        return f'PASS {name}: targeted regression rejected, exit {status}'

    with ThreadPoolExecutor(max_workers=3) as executor:
        results = list(executor.map(run_control, mutations))
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
