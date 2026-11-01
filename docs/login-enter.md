# Login Enter fallback

This change is an enhancement for a specific form shape, not a confirmed fix for
any particular website. No failing site was supplied. Microsoft login acceptance
and universal login support are not claimed.

Blink's existing `HTMLFormElement::SubmitImplicitly` first activates the form's
default submit button. Without a submit button it only submits when exactly one
control blocks implicit submission. A username/password pair has two such
controls, so Enter does nothing. The repository's existing dummy autofill page
has this shape. This matches the [HTML implicit-submission rules](https://html.spec.whatwg.org/multipage/form-control-infrastructure.html#implicit-submission)
and the [pinned Chromium implementation](https://chromium.googlesource.com/chromium/src/+/156.0.8078.47/third_party/blink/renderer/core/html/forms/html_form_element.cc).

The password overlay adds a fallback after those native paths. A trusted,
unmodified, non-repeating Enter from the focused input can advance from username
to password, or request native form submission from the password. The form must
use POST, retain validation, and contain exactly one focusable, editable text or
email input with `autocomplete="username"` and one password input with
`autocomplete="current-password"`. Hidden inputs such as CSRF tokens are allowed.
Both login values must be nonempty before submission. Constraint validation,
custom validity, cancelable submit handlers, sandbox/CSP and navigation remain
in Blink's existing submission pipeline.

Any other associated control prevents the fallback, including a disabled submit
button, a custom Next button, MFA field, checkbox, textarea or form-associated
custom element. Unannotated forms, compound autocomplete tokens, registration,
GET, dialog and novalidate forms keep their previous behavior. The fallback uses
native form ownership, including `form=` associations, and never searches another
form, document or frame for buttons or credentials. Native submit buttons and
single-field/multi-step forms keep priority. Ambiguous custom login flows remain
unsupported by this fallback.

The [existing input default handler](https://chromium.googlesource.com/chromium/src/+/156.0.8078.47/third_party/blink/renderer/core/html/forms/html_input_element.cc)
and browser autofill/keyboard routing are unchanged. Site cancellation and picker
selection occur before this default action. There is no extension content script,
new permission, credential transfer, credential logging or submission on fill or
focus. Synthetic events, composition, held Enter and modifier shortcuts are
excluded from the fallback.

## Verification and evidence

Before production edits, the following failed against stock Chrome in a fresh,
temporary browser context, with `actual: 'username', expected: 'password'`:

```sh
node tests/passwords/enter-browser.mjs
```

The runner uses Playwright from `tests/ai/node_modules` by default. Set
`BREEZER_PLAYWRIGHT_MODULE` to an existing installation if necessary. It uses
stock Chrome on macOS unless `BREEZER_TEST_BROWSER` specifies an executable.
It starts only a loopback dummy fixture and never opens a personal profile.

The original failing interaction remains a pending compiled-Breezer check. Running
it against stock Chrome after the source edit still fails, as expected. No page
script emulates the new behavior to turn that result green.

Verified independently:

- `python3 script/check_breezer_passwords.py --offline`: 23 pinned-source checks
  passed, including four new Enter contracts, eight password checks, six proactive
  password checks and five passkey checks. Overlay application, verification,
  retry, source hashes, drift refusal and untouched source fixtures passed.
- `node tests/passwords/enter-browser.mjs --baseline`: 32 real-page scenarios
  passed in stock Chrome. Baseline mode explicitly expects the enhancement to be
  absent. It checks native submission without duplicates, validation, multiple
  forms, `form=` ownership, native multi-step login, disabled/other controls,
  cancellation, synthetic/modifier/repeated Enter, removal during change, editing,
  and same-origin/cross-origin frame isolation. The picker case is a site-owned
  picker fixture, not Chromium's saved-password popup.
- `node --test tests/passwords.test.mjs tests/passkeys.test.mjs`: four tests passed.

[The captured baseline](evidence/login-enter-baseline/login-enter.png) shows the
dummy password focused and the status still Ready after Enter. It is evidence of
the missing behavior, not of a rebuilt Breezer working. Source and browser output
are recorded in [verification.txt](evidence/login-enter-baseline/verification.txt).

Four `HTMLFormElementTest.BreezerLoginEnter*` native tests are included in the
overlay. They cover advance/submit, synthetic/composition/modifier/repeat guards,
other controls and validation. They have not been compiled or executed. Neither
source assertions nor the stock-browser baseline prove the patched C++ compiles
or the new behavior works in Breezer.

## Native acceptance gate

During 1.2.0 release verification, the compiled combined candidate failed the
first non-baseline scenario: username Enter left focus on the username. The
pinned `TextFieldInputType::ShouldSubmitImplicitly` accepts a newline `TextEvent`,
and `EventHandler::HandleTextInputEvent` wraps the original keypress as its
underlying event. The fallback previously accepted only a direct `KeyboardEvent`.
It now also resolves that newline event's trusted underlying Enter, rejecting
paste, drop and composition. The native tests use the same wrapped event shape.
Fresh compilation and the non-baseline runtime rerun remain required before
calling this repair accepted.

The release coordinator confirmed there is no verified disposable compiled
Breezer or configured native unit output. Do not change the frozen PC build,
stopped Mac build, installed app or prepared-source markers to run these checks.
This overlay changes its preparation fingerprint and needs the normal fresh-stage
or verified migration workflow later.

Before accepting the native feature:

1. Compile and run `blink_unittests` with
   `--gtest_filter=HTMLFormElementTest.BreezerLoginEnter*` in an authorized isolated
   build. This gate also checks the patch's native API compatibility.
2. Run `BREEZER_TEST_BROWSER=/path/to/disposable/Breezer node
   tests/passwords/enter-browser.mjs` without `--baseline`. All 32 scenarios must
   pass. Capture a new screenshot showing exactly one submission.
3. In a disposable profile with only dummy credentials, open the native saved
   password picker and confirm first Enter selects/fills without submitting.
   Confirm second Enter works after the picker closes. Test IME commit and Return
   and keypad Enter, accessibility focus announcements and native multi-step
   password/SSO/2FA behavior. Keep consent and MFA under site control.
4. Confirm form removal/navigation, sandboxed frames and disabled controls remain
   conservative. Test any reported real site separately without recording real
   credentials. No Microsoft acceptance result currently exists.

Until these pass, this is a source implementation awaiting native acceptance.
