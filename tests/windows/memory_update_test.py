"""Resource pin migration must preserve compiled outputs and be safe to resume."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[2] / 'script/windows/apply-memory-update.py'
spec = importlib.util.spec_from_file_location('memory_update', SCRIPT)
migration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migration)


class MemoryUpdateTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='breezer-memory-update-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.target = self.root / 'components/breezer_ai/page-context.js'
        self.target.parent.mkdir(parents=True)
        self.target.write_text('old resource')
        self.packet = self.root / 'packet'
        self.packet.mkdir()
        (self.packet / 'page-context.js').write_text('new resource')
        self.old = hashlib.sha256(b'old resource').hexdigest()
        self.new = hashlib.sha256(b'new resource').hexdigest()
        self.translation = self.target.with_name('translation-content.js')
        self.translation.write_text('old translation')
        (self.packet / 'translation-content.js').write_text('new translation')
        self.workspace = self.target.with_name('workspace.js')
        self.workspace.write_text('old workspace')
        (self.packet / 'workspace.js').write_text('new workspace')
        self.workspace_old = hashlib.sha256(b'old workspace').hexdigest()
        self.workspace_new = hashlib.sha256(b'new workspace').hexdigest()
        self.translation_old = hashlib.sha256(b'old translation').hexdigest()
        self.translation_new = hashlib.sha256(b'new translation').hexdigest()
        (self.packet / 'memory-update.json').write_text(json.dumps({'resources': {
            'page-context.js': {'before': self.old, 'after': self.new},
            'translation-content.js': {'before': self.translation_old, 'after': self.translation_new},
            'workspace.js': {'before': self.workspace_old, 'after': self.workspace_new}}}))
        self.plan = self.root / 'plan.json'
        self.plan.write_text(json.dumps({'sourceChanges': {'components/breezer_ai/page-context.js': {'after': self.old},
                                  'components/breezer_ai/translation-content.js': {'after': self.translation_old},
                                  'components/breezer_ai/workspace.js': {'after': self.workspace_old}}, 'otherPin': 123}))
        self.sync_names = ('workspace-sync.js', 'workspace-sync-model.js', 'workspace-store.js', 'newtab.js', 'panel.js', 'render-message.js')
        updates = json.loads((self.packet / 'memory-update.json').read_text())
        plan = json.loads(self.plan.read_text())
        for name in self.sync_names:
            self.target.with_name(name).write_text('old ' + name)
            (self.packet / name).write_text('new ' + name)
            old = hashlib.sha256(('old ' + name).encode()).hexdigest()
            new = hashlib.sha256(('new ' + name).encode()).hexdigest()
            updates['resources'][name] = {'before': old, 'after': new}
            plan['sourceChanges']['components/breezer_ai/' + name] = {'after': old}
        self.native_relative = 'chrome/browser/sync/breezer_sync/provider_transport.cc'
        self.native = self.root / self.native_relative
        self.native.parent.mkdir(parents=True)
        self.native.write_text('old native transport')
        self.native_packet = self.packet / 'native-provider-transport.cc'
        self.native_packet.write_text('new native transport')
        self.native_old = hashlib.sha256(b'old native transport').hexdigest()
        self.native_new = hashlib.sha256(b'new native transport').hexdigest()
        updates['resources'][self.native_packet.name] = {'before': self.native_old, 'after': self.native_new}
        plan['sourceChanges'][self.native_relative] = {'after': self.native_old}
        (self.packet / 'memory-update.json').write_text(json.dumps(updates))
        self.plan.write_text(json.dumps(plan))
        self.object = self.root / 'retained.o'
        self.object.write_bytes(b'cached object')
        self.mtime = self.object.stat().st_mtime_ns

    def apply(self):
        migration.apply(self.root, self.plan, self.packet)

    def test_idempotent_update_keeps_pins_backups_and_object_cache(self):
        self.apply()
        target_mtime = self.target.stat().st_mtime_ns
        translation_mtime = self.translation.stat().st_mtime_ns
        workspace_mtime = self.workspace.stat().st_mtime_ns
        sync_mtimes = {name: self.target.with_name(name).stat().st_mtime_ns for name in self.sync_names}
        native_mtime = self.native.stat().st_mtime_ns
        self.apply()
        self.assertEqual(self.target.stat().st_mtime_ns, target_mtime)
        self.assertEqual(self.translation.stat().st_mtime_ns, translation_mtime)
        self.assertEqual(self.workspace.stat().st_mtime_ns, workspace_mtime)
        self.assertEqual(self.workspace.read_text(), 'new workspace')
        self.assertEqual(self.translation.read_text(), 'new translation')
        self.assertEqual(self.target.read_text(), 'new resource')
        plan = json.loads(self.plan.read_text())
        self.assertEqual(plan['sourceChanges']['components/breezer_ai/page-context.js']['after'], self.new)
        self.assertEqual(plan['sourceChanges']['components/breezer_ai/translation-content.js']['after'], self.translation_new)
        self.assertEqual(plan['sourceChanges']['components/breezer_ai/workspace.js']['after'], self.workspace_new)
        self.assertEqual(plan['otherPin'], 123)
        self.assertEqual(self.native.stat().st_mtime_ns, native_mtime)
        self.assertEqual(self.native.read_text(), 'new native transport')
        self.assertEqual(plan['sourceChanges'][self.native_relative]['after'], self.native_new)
        self.assertEqual(self.native.with_suffix('.cc.before-memory-update.bak').read_text(), 'old native transport')
        self.assertEqual(self.workspace.with_suffix('.js.before-memory-update.bak').read_text(), 'old workspace')
        self.assertEqual(self.translation.with_suffix('.js.before-memory-update.bak').read_text(), 'old translation')
        self.assertEqual(self.target.with_suffix('.js.before-memory-update.bak').read_text(), 'old resource')
        self.assertEqual(self.object.stat().st_mtime_ns, self.mtime)
        self.assertEqual(self.object.read_bytes(), b'cached object')
        for name in self.sync_names:
            target = self.target.with_name(name)
            self.assertEqual(target.stat().st_mtime_ns, sync_mtimes[name])
            self.assertEqual(target.read_text(), 'new ' + name)
            self.assertEqual(target.with_suffix('.js.before-memory-update.bak').read_text(), 'old ' + name)
            self.assertEqual(plan['sourceChanges']['components/breezer_ai/' + name]['after'], hashlib.sha256(target.read_bytes()).hexdigest())

    def test_resume_after_resource_write_before_pin_write(self):
        self.target.write_text('new resource')
        self.apply()
        self.assertEqual(json.loads(self.plan.read_text())['sourceChanges']['components/breezer_ai/page-context.js']['after'], self.new)
        self.assertEqual(self.translation.read_text(), 'new translation')

    def test_resume_after_native_write_before_pin_write_preserves_backup(self):
        backup = self.native.with_suffix('.cc.before-memory-update.bak')
        backup.write_text('old native transport')
        self.native.write_text('new native transport')
        native_mtime = self.native.stat().st_mtime_ns
        self.apply()
        self.assertEqual(self.native.stat().st_mtime_ns, native_mtime)
        self.assertEqual(backup.read_text(), 'old native transport')
        self.assertEqual(json.loads(self.plan.read_text())['sourceChanges'][self.native_relative]['after'], self.native_new)

    def test_unexpected_source_is_not_overwritten(self):
        self.target.write_text('user changes')
        plan = self.plan.read_bytes()
        with self.assertRaisesRegex(ValueError, 'Unexpected prepared source'):
            self.apply()
        self.assertEqual(self.target.read_text(), 'user changes')
        self.assertEqual(self.plan.read_bytes(), plan)

    def test_unexpected_pin_is_not_overwritten(self):
        self.plan.write_text(json.dumps({'sourceChanges': {'components/breezer_ai/page-context.js': {'after': 'unknown'}}}))
        with self.assertRaisesRegex(ValueError, 'Unexpected pinned resource'):
            self.apply()
        self.assertEqual(self.target.read_text(), 'old resource')

    def test_unexpected_second_resource_preserves_both_resources_and_plan(self):
        self.translation.write_text('user translation changes')
        plan = self.plan.read_bytes()
        with self.assertRaisesRegex(ValueError, 'Unexpected prepared source'):
            self.apply()
        self.assertEqual(self.target.read_text(), 'old resource')
        self.assertEqual(self.translation.read_text(), 'user translation changes')
        self.assertEqual(self.plan.read_bytes(), plan)

    def test_corrupt_second_packet_resource_is_rejected_before_any_writes(self):
        (self.packet / 'translation-content.js').write_text('corrupt translation')
        with self.assertRaisesRegex(ValueError, 'Packet resource hash mismatch'):
            self.apply()
        self.assertEqual(self.target.read_text(), 'old resource')
        self.assertEqual(self.translation.read_text(), 'old translation')

    def test_resume_after_all_resource_writes_before_pin_write(self):
        self.target.write_text('new resource')
        self.translation.write_text('new translation')
        self.workspace.write_text('new workspace')
        for name in self.sync_names:
            self.target.with_name(name).write_text('new ' + name)
        self.native.write_text('new native transport')
        self.apply()
        saved = json.loads(self.plan.read_text())['sourceChanges']
        self.assertEqual(saved['components/breezer_ai/page-context.js']['after'], self.new)
        self.assertEqual(saved['components/breezer_ai/translation-content.js']['after'], self.translation_new)
        self.assertEqual(saved[self.native_relative]['after'], self.native_new)
        for name in self.sync_names:
            self.assertEqual(saved['components/breezer_ai/' + name]['after'], hashlib.sha256(('new ' + name).encode()).hexdigest())

    def test_sync_resource_errors_are_rejected_before_any_writes(self):
        original_plan = self.plan.read_bytes()
        for name in self.sync_names:
            target = self.target.with_name(name)
            for kind in ('packet', 'source', 'pin'):
                with self.subTest(name=name, kind=kind):
                    path = (self.packet / name) if kind == 'packet' else target
                    original = path.read_bytes()
                    if kind == 'pin':
                        plan = json.loads(original_plan)
                        plan['sourceChanges']['components/breezer_ai/' + name]['after'] = 'unknown'
                        self.plan.write_text(json.dumps(plan))
                    else:
                        path.write_text('unknown changes')
                    unchanged_plan = self.plan.read_bytes()
                    unchanged_source = target.read_bytes()
                    with self.assertRaises(ValueError):
                        self.apply()
                    self.assertEqual(self.target.read_text(), 'old resource')
                    self.assertEqual(self.translation.read_text(), 'old translation')
                    self.assertEqual(self.workspace.read_text(), 'old workspace')
                    self.assertEqual(target.read_bytes(), unchanged_source)
                    self.assertEqual(self.plan.read_bytes(), unchanged_plan)
                    path.write_bytes(original)
                    self.plan.write_bytes(original_plan)

    def test_unexpected_third_resource_is_rejected_before_any_writes(self):
        self.workspace.write_text('user workspace changes')
        plan = self.plan.read_bytes()
        with self.assertRaisesRegex(ValueError, 'Unexpected prepared source'):
            self.apply()
        self.assertEqual(self.target.read_text(), 'old resource')
        self.assertEqual(self.translation.read_text(), 'old translation')
        self.assertEqual(self.workspace.read_text(), 'user workspace changes')
        self.assertEqual(self.plan.read_bytes(), plan)

    def test_native_errors_are_rejected_before_any_resource_or_plan_write(self):
        original_plan = self.plan.read_bytes()
        for kind in ('packet', 'source', 'pin'):
            with self.subTest(kind=kind):
                path = self.native_packet if kind == 'packet' else self.native
                original = path.read_bytes()
                if kind == 'pin':
                    plan = json.loads(original_plan)
                    plan['sourceChanges'][self.native_relative]['after'] = 'unknown'
                    self.plan.write_text(json.dumps(plan))
                else:
                    path.write_text('unknown native changes')
                unchanged_plan = self.plan.read_bytes()
                unchanged_native = self.native.read_bytes()
                with self.assertRaises(ValueError):
                    self.apply()
                self.assertEqual(self.target.read_text(), 'old resource')
                self.assertEqual(self.translation.read_text(), 'old translation')
                self.assertEqual(self.workspace.read_text(), 'old workspace')
                self.assertEqual(self.native.read_bytes(), unchanged_native)
                self.assertEqual(self.plan.read_bytes(), unchanged_plan)
                self.assertFalse(self.plan.with_suffix('.json.before-memory-update.bak').exists())
                path.write_bytes(original)
                self.plan.write_bytes(original_plan)

    def test_corrupt_third_packet_is_rejected_before_any_writes(self):
        (self.packet / 'workspace.js').write_text('corrupt workspace')
        with self.assertRaisesRegex(ValueError, 'Packet resource hash mismatch'):
            self.apply()
        self.assertEqual(self.target.read_text(), 'old resource')
        self.assertEqual(self.translation.read_text(), 'old translation')
        self.assertEqual(self.workspace.read_text(), 'old workspace')

    def test_corrupt_packet_is_not_applied(self):
        (self.packet / 'page-context.js').write_text('corrupt resource')
        with self.assertRaisesRegex(ValueError, 'Packet resource hash mismatch'):
            self.apply()
        self.assertEqual(self.target.read_text(), 'old resource')

    def test_packet_mutation_after_preflight_cannot_replace_validated_bytes(self):
        replace = migration.replace_bytes
        def mutate_packet(path, content):
            if path == self.plan.with_suffix('.json.before-memory-update.bak'):
                (self.packet / 'workspace-sync-model.js').write_text('concurrent packet edit')
                self.native_packet.write_text('concurrent native packet edit')
            replace(path, content)
        with patch.object(migration, 'replace_bytes', side_effect=mutate_packet):
            self.apply()
        target = self.target.with_name('workspace-sync-model.js')
        self.assertEqual(target.read_text(), 'new workspace-sync-model.js')
        self.assertEqual(json.loads(self.plan.read_text())['sourceChanges']['components/breezer_ai/workspace-sync-model.js']['after'], hashlib.sha256(target.read_bytes()).hexdigest())
        self.assertEqual(self.native.read_text(), 'new native transport')
        self.assertEqual(json.loads(self.plan.read_text())['sourceChanges'][self.native_relative]['after'], self.native_new)


if __name__ == '__main__':
    unittest.main()
