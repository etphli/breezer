#!/usr/bin/env python3
"""Recompute native transport medians and ranges from the raw paired trials."""
import argparse
import hashlib
import json
import math
import re
from pathlib import Path
import statistics


MAX_SAFE = 2**53 - 1


def require(condition, message):
    if not condition:
        raise ValueError(message)


def number(value, label, signed=False, integer=True):
    require(type(value) in (int, float) and abs(value) <= MAX_SAFE and math.isfinite(value) and (signed or value >= 0)
            and (not integer or type(value) is int), f'Invalid {label}')


def object_value(value, label):
    require(isinstance(value, dict), f'Invalid {label}')
    return value


def positive_time(value):
    return isinstance(value, str) and re.fullmatch(r'[1-9][0-9]*', value) is not None and int(value) <= 2**64 - 1


def validate_usage(usage, pid):
    object_value(usage, 'usage')
    require(type(usage.get('schema')) is int and usage['schema'] == 1, 'Invalid usage schema')
    require(positive_time(usage.get('captureStartedNs')) and positive_time(usage.get('captureEndedNs'))
            and int(usage['captureEndedNs']) >= int(usage['captureStartedNs']), 'Invalid capture bounds')
    rows = usage.get('processes')
    require(isinstance(rows, list) and len(rows) == 1, 'Expected one usage process')
    row = object_value(rows[0], 'usage process')
    number(row.get('pid'), 'usage PID')
    require(row['pid'] == pid and row.get('status') == 'ok', 'Unsuccessful or mismatched usage PID')
    require(positive_time(row.get('startAbstime')) and isinstance(row.get('executableUuid'), str)
            and re.fullmatch(r'[a-f0-9]{32}', row['executableUuid']), 'Invalid native identity')
    for key in ('physicalFootprintBytes', 'residentBytes', 'lifetimeMaxPhysicalFootprintBytes'):
        number(row.get(key), key)
    require(row['lifetimeMaxPhysicalFootprintBytes'] >= row['physicalFootprintBytes'], 'Invalid lifetime footprint')
    return row


def validate_sample(sample, runtime, pid=None):
    object_value(sample, 'sample')
    number(sample.get('pid'), 'sample PID')
    require(sample['pid'] > 0 and (pid is None or sample['pid'] == pid), 'Mismatched sample PID')
    require(sample.get('node') == runtime, 'Mismatched sample runtime')
    for group, keys in (('memory', ('rss', 'heapTotal', 'heapUsed', 'external', 'arrayBuffers')),
                        ('cpu', ('user', 'system'))):
        data = object_value(sample.get(group), group)
        for key in keys:
            number(data.get(key), f'{group}.{key}')
    return sample['pid']


def validate_trial(trial, runtime, require_footprint=True):
    object_value(trial, 'trial')
    pid = validate_sample(trial.get('before'), runtime)
    validate_sample(trial.get('after'), runtime, pid)
    if 'pid' in trial:
        require(trial['pid'] == pid and type(trial['pid']) is int, 'Mismatched trial PID')
    number(trial.get('replyMs'), 'replyMs', integer=False)
    for metric, group, key, signed in (
        ('cpuUserMicros', 'cpu', 'user', False), ('cpuSystemMicros', 'cpu', 'system', False),
        ('retainedArrayBufferBytes', 'memory', 'arrayBuffers', True)):
        number(trial.get(metric), metric, signed=signed)
        require(trial[metric] == trial['after'][group][key] - trial['before'][group][key], f'Invalid {metric} delta')
    usage = trial.get('usage')
    if usage is None:
        require(not require_footprint and trial.get('usageBefore') is None, 'Missing footprint capture')
    else:
        after = validate_usage(usage, pid)
        if 'usageBefore' in trial:
            before = validate_usage(trial['usageBefore'], pid)
            require(all(before[key] == after[key] for key in ('pid', 'startAbstime', 'executableUuid')),
                    'Native identity changed')
            require(int(trial['usageBefore']['captureEndedNs']) <= int(usage['captureStartedNs']), 'Overlapping capture bounds')


def validate_report(report, require_footprint=True):
    object_value(report, 'report')
    # Legacy Nov 2 reports predate report-level schema; explicit schemas must be supported.
    require('schema' not in report or type(report['schema']) is int and report['schema'] == 1, 'Invalid report schema')
    require(report.get('status') == 'passed', 'Unsuccessful trial report')
    runtime = object_value(report.get('runtime'), 'runtime')
    require(isinstance(runtime.get('path'), str) and runtime['path'].startswith('/')
            and isinstance(runtime.get('version'), str) and re.fullmatch(r'v[0-9]+\.[0-9]+\.[0-9]+', runtime['version']), 'Invalid runtime identity')
    sources = object_value(report.get('otherHostSources'), 'sources')
    require(bool(sources) and all(isinstance(k, str) and re.fullmatch(r'[^/]+\.mjs', k) and k != 'protocol.mjs' for k in sources), 'Invalid host sources')
    for label, value in [('runtime hash', runtime.get('sha256')),
                         ('baseline hash', report.get('baselineProtocolSha256')),
                         ('candidate hash', report.get('candidateProtocolSha256')), *sources.items()]:
        require(isinstance(value, str) and re.fullmatch(r'[a-f0-9]{64}', value), f'Invalid {label}')
    for key in ('payloadBytes', 'chunkBytes', 'pairedRounds'):
        number(report.get(key), key)
        require(report[key] > 0, f'Invalid {key}')
    require(report['pairedRounds'] <= 10 and report['payloadBytes'] < 16 * 1024**2 - 1024, 'Invalid trial dimensions')
    trials = report.get('results')
    require(isinstance(trials, list) and len(trials) == report['pairedRounds'] * 2, 'Invalid result count')
    expected = [(name, r) for r in range(report['pairedRounds'])
                for name in (('candidate', 'baseline') if r % 2 else ('baseline', 'candidate'))]
    for trial, pair in zip(trials, expected):
        object_value(trial, 'trial')
        require(type(trial.get('round')) is int and (trial.get('name'), trial['round']) == pair, 'Invalid pair order or identity')
        if report.get('schema') == 1 and trial.get('usage') is not None:
            require(trial.get('usageBefore') is not None, 'Missing bracketed footprint capture')
        validate_trial(trial, runtime['version'], require_footprint)


def summarize(paths):
    reports = [(path, json.loads(path.read_text())) for path in paths]
    require(bool(reports), 'No reports')
    for path, report in reports:
        try:
            validate_report(report)
        except ValueError as error:
            raise ValueError(f'{path}: {error}') from error
    reports.sort(key=lambda item: item[1]['payloadBytes'])
    require(len({r['payloadBytes'] for _, r in reports}) == len(reports), 'Repeated payload report')
    first = reports[0][1]
    metrics = []
    for path, report in reports:
        if report['status'] != 'passed':
            raise ValueError(f'Unsuccessful trial report: {path}')
        for key in ('runtime', 'baselineProtocolSha256', 'candidateProtocolSha256', 'otherHostSources', 'pairedRounds', 'chunkBytes'):
            if report[key] != first[key]:
                raise ValueError(f'Mixed {key} in {path}')
        result = {'payloadMiB': report['payloadBytes'] / 1024**2}
        for name in ('baseline', 'candidate'):
            trials = [trial for trial in report['results'] if trial['name'] == name]
            if sorted(trial['round'] for trial in trials) != list(range(report['pairedRounds'])):
                raise ValueError(f'Missing or repeated {name} pair in {path}')
            samples = {
                'footprintMiB': [trial['usage']['processes'][0]['physicalFootprintBytes'] / 1024**2 for trial in trials],
                'cpuMs': [(trial['cpuUserMicros'] + trial['cpuSystemMicros']) / 1000 for trial in trials],
                'replyMs': [trial['replyMs'] for trial in trials],
                'retainedArrayBufferBytes': [trial['retainedArrayBufferBytes'] for trial in trials],
            }
            result[name] = {key: {'median': statistics.median(values), 'min': min(values), 'max': max(values)}
                            for key, values in samples.items()}
        metrics.append(result)
    return {
        'runtime': first['runtime']['version'],
        'runtimeIdentity': first['runtime'],
        'candidateProtocolSha256': first['candidateProtocolSha256'],
        'baselineProtocolSha256': first['baselineProtocolSha256'],
        'pairedRoundsPerPayload': first['pairedRounds'],
        'rawReports': {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path, _ in reports},
        'metrics': metrics,
        'scope': 'Single actual native host, synthetic invalid settings frames, forced GC, no provider/Keychain/network/config changes; not whole-browser RAM or AI latency. CPU includes validation, transport and post-request forced GC.',
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('reports', nargs='+', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    args.output.write_text(json.dumps(summarize(args.reports), indent=2) + '\n')


if __name__ == '__main__':
    main()
