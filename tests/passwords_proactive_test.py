"""Source/config regressions; only temporary copies of named source files change.

BREEZER_PASSWORD_SOURCE may point at a Helium baseline or a tree with this
password overlay. These checks do not compile or launch Chromium.
"""

import ast
import importlib.util
import itertools
import os
from pathlib import Path
import re
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    'password_overlay', ROOT / 'features/passwords/native-ui/apply.py')
overlay = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(overlay)
SOURCE = os.environ.get('BREEZER_PASSWORD_SOURCE')
FEATURES = 'components/password_manager/core/browser/features/password_features.cc'
CONTEXT = 'chrome/browser/renderer_context_menu/render_view_context_menu.cc'
CLIENT = 'chrome/browser/password_manager/chrome_password_manager_client.cc'
UI = 'chrome/browser/ui/passwords/manage_passwords_ui_controller.cc'
UI_HEADER = 'chrome/browser/ui/passwords/manage_passwords_ui_controller.h'
PAGE_ACTION = 'chrome/browser/ui/views/passwords/manage_passwords_page_action_controller.cc'
FILLING = 'components/password_manager/core/browser/password_form_filling.cc'
BUBBLE_EXPERIMENT = 'components/password_manager/core/browser/password_bubble_experiment.cc'
MENU_MANAGER = 'chrome/browser/ui/autofill/autofill_context_menu_manager.cc'


def body(source, signature):
    """Get a balanced C++ function/block body without interpreting credentials."""
    start = source.index('{', source.index(signature)) + 1
    depth = 1
    for end in range(start, len(source)):
        depth += (source[end] == '{') - (source[end] == '}')
        if depth == 0:
            return source[start:end]
    raise AssertionError(f'Unclosed function: {signature}')


def evaluate_condition(expression, substitutions):
    """Run the shipped boolean guard over dummy states, not a copied predicate."""
    for call, name in substitutions.items():
        expression = expression.replace(call, name)
    expression = expression.replace('&&', ' and ').replace('||', ' or ')
    expression = ' '.join(re.sub(r'!(?!=)', ' not ', expression).split())
    parsed = ast.parse(expression, mode='eval')
    allowed = (ast.Expression, ast.BoolOp, ast.And, ast.Or, ast.UnaryOp,
               ast.Not, ast.Name, ast.Load)
    if any(not isinstance(node, allowed) for node in ast.walk(parsed)):
        raise AssertionError('Unexpected native chip guard syntax')
    return compile(parsed, '<native password chip guard>', 'eval')


@unittest.skipUnless(SOURCE, 'Set BREEZER_PASSWORD_SOURCE to read pinned source files')
class ProactivePasswordSourceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory(prefix='breezer-password-opportunities-')
        cls.addClassCleanup(cls.directory.cleanup)
        cls.tree = Path(cls.directory.name)
        paths = set(overlay.sections()) | {
            FEATURES, CONTEXT, CLIENT, UI, UI_HEADER, PAGE_ACTION, FILLING,
            BUBBLE_EXPERIMENT, MENU_MANAGER,
        }
        cls.observed = {name: (Path(SOURCE) / name).read_bytes() for name in paths}
        for name, data in cls.observed.items():
            target = cls.tree / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        overlay.apply(cls.tree)

    def read(self, name):
        return (self.tree / name).read_text()

    def test_password_fields_reach_native_contextual_fill_menu(self):
        menu = body(self.read(CONTEXT), 'void RenderViewContextMenu::InitMenu()')
        self.assertTrue('autofill_context_menu_manager_.AppendItems();' in menu,
                        'Helium removed native password-field fill fallback')
        guard = re.search(r'if \(([^{}]+)\) \{\s*'
                          r'autofill_context_menu_manager_\.AppendItems\(\);', menu)
        self.assertIsNotNone(guard, 'native fill fallback needs a password-only guard')
        self.assertIn('ContextMenuContentType::ITEM_GROUP_AUTOFILL', guard[1])
        self.assertIn('blink::mojom::FormControlType::kInputPassword', guard[1])
        manager = self.read(MENU_MANAGER)
        self.assertIn('IsFillingEnabled(', body(manager,
                      'bool AutofillContextMenuManager::ShouldAddPasswordsManualFallbackItem('))
        self.assertIn('kInputPassword', body(manager,
                      'bool AutofillContextMenuManager::MaybeAddAtMemoryItem()'))
        self.assertIn('return false;', body(manager,
                      'bool AutofillContextMenuManager::MaybeAddAtMemoryItem()'))

    def test_native_fill_requires_account_selection_by_default(self):
        feature = re.search(r'BASE_FEATURE\(kFillOnAccountSelect,\s*'
                            r'"fill-on-account-select",\s*([^)]*)\)', self.read(FEATURES))
        self.assertIsNotNone(feature)
        self.assertEqual(feature[1].strip(), 'base::FEATURE_ENABLED_BY_DEFAULT',
                         'eligible logins must be offered for selection, not filled on page load')
        filling = self.read(FILLING)
        self.assertIn('wait_for_username_reason = WaitForUsernameReason::kFoasFeature;', filling)
        self.assertIn('result.wait_for_username = wait_for_username;', filling)
        for native_guard in ['client->IsOffTheRecord()', 'driver->HasCrossOriginAncestor()',
                             'WaitForUsernameReason::kPublicSuffixMatch',
                             'WaitForUsernameReason::kInsecureOrigin']:
            self.assertIn(native_guard, filling)

    def test_save_update_cue_is_visible_and_uses_native_actions(self):
        page_action = self.read(PAGE_ACTION)
        self.assertTrue('passwords_ui_controller.ShouldShowSaveUpdateChip()' in page_action,
                        'pending native save/update has no visible action cue')
        self.assertIn('ShowSuggestionChip(', page_action)
        self.assertIn('HideSuggestionChip(', page_action)
        self.assertIn('ClearOverrideText(', page_action)
        self.assertIn('.should_animate = false', page_action,
                      'typing and state refresh must not replay attention animations')
        self.assertIn('IDS_UPDATE_PASSWORD', page_action)
        self.assertIn('IDS_SAVE_PASSWORD', page_action)
        self.assertIn('bool ShouldShowSaveUpdateChip() const;', self.read(UI_HEADER))
        # A chip must only open the existing native bubble on user action.
        self.assertNotIn('SavePassword(', page_action)
        self.assertNotIn('QueueOrShowBubble(', page_action)

    def test_cue_guard_exhaustive_dummy_states(self):
        signature = 'bool ManagePasswordsUIController::ShouldShowSaveUpdateChip() const'
        self.assertTrue(signature in self.read(UI), 'native save/update cue guard is missing')
        cue = body(self.read(UI), signature)
        self.assertEqual(cue.count('return '), 1)
        expression = cue.strip().removeprefix('return ').removesuffix(';')
        substitutions = {
            'GetState() == password_manager::ui::PENDING_PASSWORD_UPDATE_STATE': 'pending_update',
            'GetState() == password_manager::ui::PENDING_PASSWORD_STATE': 'pending_save',
            'GetSavingPromptStatus() == SavingPromptStatus::kCanShow': 'prompt_allowed',
            'passwords_data_.client()->IsSavingAndFillingEnabled(GetOrigin())': 'saving_enabled',
            'IsAutomaticallyOpeningBubble()': 'opening',
            'IsShowingBubble()': 'showing',
            'BubbleManagerHasPasswordBubbleInQueue()': 'queued',
            'passwords_data_.client()->IsActorTaskActive()': 'actor_active',
            'IsPasswordChangeOngoing()': 'password_change',
        }
        condition = evaluate_condition(expression, substitutions)
        names = list(substitutions.values())
        for bits in itertools.product([False, True], repeat=len(names)):
            values = dict(zip(names, bits))
            expected = ((values['pending_save'] or values['pending_update'])
                        and values['prompt_allowed'] and values['saving_enabled']
                        and not any(values[name] for name in
                                    ['opening', 'showing', 'queued', 'actor_active', 'password_change']))
            self.assertEqual(eval(condition, {'__builtins__': {}}, values), expected, values)

    def test_native_save_suppression_and_submission_pipeline_are_preserved(self):
        ui = self.read(UI)
        prompt = body(ui, 'ManagePasswordsUIController::GetSavingPromptStatus() const')
        self.assertIn('IsExplicitlyBlocklisted()', prompt)
        self.assertIn('GetSmartBubbleDismissalThreshold()', prompt)
        self.assertIn('stats->dismissal_count >= show_threshold', prompt)
        experiment = body(self.read(BUBBLE_EXPERIMENT), 'int GetSmartBubbleDismissalThreshold()')
        self.assertIn('return 3;', experiment)
        client = body(self.read(CLIENT), 'bool ChromePasswordManagerClient::IsSavingAndFillingEnabled(')
        for gate in ['switches::kEnableAutomation', 'kOfferToSavePasswords',
                     '!IsOffTheRecord()', 'IsFillingEnabled(origin, url)']:
            self.assertIn(gate, client)
        # Existing prompt scheduling, failed-login detection, and fallback timer
        # stay byte-for-byte native. Only a new read-only cue predicate is added.
        for signature in ['void ManagePasswordsUIController::OnPasswordSubmitted(',
                          'void ManagePasswordsUIController::OnUpdatePasswordSubmitted(',
                          'void ManagePasswordsUIController::OnShowManualFallbackForSaving(',
                          'void ManagePasswordsUIController::OnHideManualFallbackForSaving(']:
            self.assertEqual(body(ui, signature), body(self.observed[UI].decode(), signature))
        for name, observed in self.observed.items():
            self.assertEqual((Path(SOURCE) / name).read_bytes(), observed,
                             'the supplied native source must remain untouched')


if __name__ == '__main__':
    unittest.main()
