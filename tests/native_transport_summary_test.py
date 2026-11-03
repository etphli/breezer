import copy
import importlib.util
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('transport', ROOT / 'script/summarize_native_transport.py')
transport = importlib.util.module_from_spec(spec)
spec.loader.exec_module(transport)
EVIDENCE = ROOT / 'docs/evidence/memory-20261102'
PATHS = sorted(EVIDENCE.glob('native-transport-final-*.json'))


class SummaryTests(unittest.TestCase):
    def setUp(self):
        self.report = json.loads(PATHS[0].read_text())

    def test_historical_trials(self):
        self.assertEqual(len(PATHS), 5)
        count = 0
        for path in PATHS:
            report = json.loads(path.read_text())
            transport.validate_report(report)
            count += len(report['results'])
        self.assertEqual(count, 60)
        self.assertEqual(transport.summarize(PATHS), json.loads((EVIDENCE / 'native-transport-summary.json').read_text()))

    def test_audit_fixture_rejected(self):
        for trial in self.report['results']:
            trial['usage'].update(schema=999)
            trial['usage']['processes'][0].update(pid=999, status='error', physicalFootprintBytes=-1048576)
        with self.assertRaises(ValueError):
            transport.validate_report(self.report)

    def test_malformed_boundaries(self):
        mutations = [
            lambda r: r.update(schema=999),
            lambda r: r.update(pairedRounds=6.0),
            lambda r: r.update(schema=1),
            lambda r: r['runtime'].update(sha256='bad'),
            lambda r: r.update(otherHostSources={}),
            lambda r: r['results'].append(copy.deepcopy(r['results'][0])),
            lambda r: r['results'][0].update(name='unknown'),
            lambda r: r['results'][0].update(round=True),
            lambda r: r['results'][0]['usage'].update(schema=999),
            lambda r: r['results'][0]['usage']['processes'][0].update(pid=999),
            lambda r: r['results'][0]['usage']['processes'][0].update(status='error'),
            lambda r: r['results'][0]['usage']['processes'][0].update(physicalFootprintBytes=-1),
            lambda r: r['results'][0]['usage'].update(captureEndedNs='1'),
            lambda r: r['results'][0]['usage']['processes'][0].update(startAbstime='0'),
            lambda r: r['results'][0]['usage']['processes'][0].update(executableUuid='bad'),
            lambda r: r['results'][0]['after'].update(pid=999),
            lambda r: r['results'][0]['before'].update(node='v0.0.0'),
            lambda r: r['results'][0]['after']['memory'].update(rss=float('nan')),
            lambda r: r['results'][0].update(replyMs=float('inf')),
            lambda r: r['results'][0].update(cpuUserMicros=-1),
            lambda r: r['results'][0].update(cpuSystemMicros=0.5),
            lambda r: r['results'][0].update(retainedArrayBufferBytes=999),
            lambda r: r['results'][0].update(usage=None),
        ]
        for index, mutate in enumerate(mutations):
            with self.subTest(index=index):
                report = copy.deepcopy(self.report)
                mutate(report)
                with self.assertRaises(ValueError):
                    transport.validate_report(report)

    def test_signed_memory_and_optional_diagnostic(self):
        trial = self.report['results'][0]
        trial['after']['memory']['arrayBuffers'] = trial['before']['memory']['arrayBuffers'] - 1
        trial['retainedArrayBufferBytes'] = -1
        transport.validate_report(self.report)
        for trial in self.report['results']:
            trial['usage'] = None
            trial['usageBefore'] = None
        transport.validate_report(self.report, require_footprint=False)
        with self.assertRaises(ValueError):
            transport.validate_report(self.report)

    def test_bracketed_identity(self):
        trial = self.report['results'][0]
        trial['usageBefore'] = copy.deepcopy(trial['usage'])
        trial['usageBefore']['captureStartedNs'] = '1'
        trial['usageBefore']['captureEndedNs'] = '2'
        transport.validate_report(self.report)
        trial['usageBefore']['processes'][0]['startAbstime'] = '123'
        with self.assertRaisesRegex(ValueError, 'Native identity changed'):
            transport.validate_report(self.report)

    def test_mixed_sources(self):
        # Cross-report consistency is checked on recorded hashes, never today's source.
        import tempfile
        with tempfile.TemporaryDirectory(prefix='breezer-transport-summary-') as directory:
            report = copy.deepcopy(self.report)
            report['payloadBytes'] += 1
            report['otherHostSources']['claude.mjs'] = 'a' * 64
            path = Path(directory) / 'mixed.json'
            path.write_text(json.dumps(report))
            with self.assertRaisesRegex(ValueError, 'Mixed otherHostSources'):
                transport.summarize([PATHS[0], path])


if __name__ == '__main__':
    unittest.main()
