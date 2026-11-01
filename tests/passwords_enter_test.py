"""Pinned-source contracts only. Does not compile or execute Blink."""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest

from passwords_proactive_test import body

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('password_overlay', ROOT / 'features/passwords/native-ui/apply.py')
overlay = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(overlay)
SOURCE = os.environ.get('BREEZER_PASSWORD_SOURCE')
FORM = 'third_party/blink/renderer/core/html/forms/html_form_element.cc'
UNIT = 'third_party/blink/renderer/core/html/forms/html_form_element_test.cc'


@unittest.skipUnless(SOURCE, 'Set BREEZER_PASSWORD_SOURCE to a disposable pinned fixture')
class LoginEnterSourceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory(prefix='breezer-login-enter-source-')
        cls.addClassCleanup(cls.directory.cleanup)
        cls.tree = Path(cls.directory.name)
        cls.observed = {name: (Path(SOURCE) / name).read_bytes() for name in overlay.sections()}
        for name, data in cls.observed.items():
            target = cls.tree / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        overlay.apply(cls.tree)
        cls.source = (cls.tree / FORM).read_text()
        cls.submit = body(cls.source, 'void HTMLFormElement::SubmitImplicitly(')

    def test_native_submission_has_priority(self):
        fallback = self.submit.index('// Breezer:')
        for native in ['CanBeSuccessfulSubmitButton()', 'IsSuccessfulSubmitButton()',
                       'DispatchSimulatedClick(&event)', 'SubmitBehavior()',
                       'submission_trigger_count == 1']:
            self.assertLess(self.submit.index(native), fallback)
        # All existing form validation/navigation machinery stays unchanged.
        baseline = self.tree / FORM
        result = overlay.patch(self.tree, overlay.sections()[FORM], reverse=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        original = baseline.read_text()
        for signature in ['bool HTMLFormElement::ValidateInteractively()',
                          'void HTMLFormElement::PrepareForSubmission(',
                          'void HTMLFormElement::ScheduleFormSubmission(']:
            self.assertEqual(body(self.source, signature), body(original, signature))
        overlay.apply(self.tree)

    def test_trusted_unmodified_enter_only(self):
        for guard in ['!event.isTrusted()', 'event.defaultPrevented()', 'event.DefaultHandled()', '!key',
                      'event.type() != event_type_names::kKeypress', "key->charCode() != '\\r'",
                      'key->isComposing()', 'key->repeat()', 'key->ctrlKey()',
                      'key->altKey()', 'key->metaKey()', 'key->shiftKey()',
                      '!isConnected()', '!GetDocument().IsActive()']:
            self.assertIn(guard, self.submit)

    def test_exact_form_and_explicit_login_pair(self):
        for guard in ['submission_trigger_count != 2', 'event.RawTarget() != focused',
                      'focused->Form() != this', 'input->Form() != this',
                      'FormSubmission::kPostMethod', 'NoValidate()',
                      'input->IsDisabledOrReadOnly()', '!input->IsFocusable()',
                      'FormControlType::kInputHidden', 'FormControlType::kInputEmail',
                      'FormControlType::kInputPassword', '"username"', '"current-password"']:
            self.assertIn(guard, self.submit)
        self.assertIn('username->Value().empty() || !username->ListedElement::IsValidElement()', self.submit)
        self.assertIn('password->Value().empty()', self.submit)
        self.assertIn('password->Focus();', self.submit)
        self.assertTrue(self.submit.strip().endswith('PrepareForSubmission(&event, nullptr);'))

    def test_native_regressions_are_staged_and_original_fixture_untouched(self):
        unit = (self.tree / UNIT).read_text()
        for name in ['BreezerLoginEnterAdvancesThenSubmitsOnce',
                     'BreezerLoginEnterRejectsSyntheticCompositionAndModifiers',
                     'BreezerLoginEnterDoesNotBypassOtherControls', 'BreezerLoginEnterKeepsValidation']:
            self.assertIn(name, unit)
        for name, data in self.observed.items():
            self.assertEqual((Path(SOURCE) / name).read_bytes(), data)


if __name__ == '__main__':
    unittest.main()
