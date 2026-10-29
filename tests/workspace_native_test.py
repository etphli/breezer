"""Source-level sidebar regressions; no browser launch or native compilation.

BREEZER_WORKSPACE_PRISTINE points to a read-only pinned-source fixture cache.
The completion replay models the native callback ordering, not macOS input.
Run the injected browser_tests cases to verify the real native behavior.
"""

import os
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'script'))
import apply_breezer_workspace as workspace
import breezer_sidebar_frame as frame
import check_ai_overlay as fixture


def method(text, signature):
    return text.split(signature, 1)[1].split('\n}', 1)[0]


@unittest.skipUnless(os.environ.get('BREEZER_WORKSPACE_PRISTINE'),
                     'Set BREEZER_WORKSPACE_PRISTINE to the pinned-source cache')
class SidebarNativeSourceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        fixture.CACHE = Path(os.environ['BREEZER_WORKSPACE_PRISTINE'])
        with tempfile.TemporaryDirectory(prefix='breezer-sidebar-regression-') as directory:
            tree = Path(directory)
            fixture.prepare(tree, offline=True,
                            wanted_paths=(frame.REGION, frame.REGION_HEADER))
            cls.region = workspace.transform(frame.REGION, (tree / frame.REGION).read_bytes()).decode()
            cls.header = workspace.transform(frame.REGION_HEADER, (tree / frame.REGION_HEADER).read_bytes()).decode()

    def test_collapse_completion_cannot_clear_new_hover_motion(self):
        body = method(self.region, 'void VerticalTabStripRegionView::OnCollapseStateChanged(')
        # Replay kEnded -> SetCollapsed -> OnCollapseStateChanged while the zen
        # keep-expanded lock is held. GroupData clears its motion AFTER kEnded.
        motion = 'collapse'
        pending = []

        def update_hover():
            nonlocal motion
            motion = 'expand-on-hover'

        if 'PostTask(' in body:
            self.assertIn('weak_factory_.GetWeakPtr()', body)
            self.assertIn('&VerticalTabStripRegionView::UpdateExpandOnHoverState', body)
            self.assertIn('std::nullopt', body)
            pending.append(update_hover)
        else:
            self.assertIn('UpdateExpandOnHoverState();', body)
            update_hover()
        motion = None  # GroupData::OnAnimationEnded resumes after Notify(kEnded).
        for task in pending:
            task()
        self.assertEqual(motion, 'expand-on-hover',
                         'kEnded cleared the reentrant hover motion; next native tick CHECKs')
        self.assertIn('base::WeakPtrFactory<VerticalTabStripRegionView>', self.header)

    def test_hidden_bottom_container_cannot_claim_workspace_mouse(self):
        caption = method(self.region, 'bool VerticalTabStripRegionView::IsPositionInWindowCaption(')
        self.assertIn('bottom_button_container_->GetVisible() &&', caption,
                      'hidden bottom container retains stale bounds and claims HTCAPTION')
        self.assertIn('resize_area_->GetVisible() &&', caption)
        self.assertIn('workspace->IsDrawn()', caption)
        self.assertIn('IsHitInView(workspace, point)', caption)
        self.assertLess(caption.index('IsHitInView(resize_area_, point)'),
                        caption.index('IsHitInView(workspace, point)'))
        self.assertLess(caption.index('IsHitInView(workspace, point)'),
                        caption.index('IsHitInView(bottom_button_container_, point)'))
        self.assertIn('return workspace->IsPointInTitlebar(', caption)


if __name__ == '__main__':
    unittest.main()
