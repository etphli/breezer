# Proactive native passwords

This overlay keeps credential handling in Chromium. It adds a quiet native
Save password / Update password chip while a native pending save or update is
available. Clicking it uses the existing password action and bubble. Submission
detection, failed-login detection, save/update prompts, the fallback timer, and
password storage are unchanged.

The chip is hidden for never-save sites, native dismissal suppression, disabled
saving, private browsing, active or queued password bubbles, actor tasks, and
native password-change flows. It uses the existing three-dismissal threshold.
It does not replay chip animations while typing. The native page-action selector
still decides whether there is room to display the chip.

Password fields regain Chromium's native Select password / Suggest password
context menu. The restoration is limited to `input[type=password]`, so it does
not re-enable unrelated Autofill or AtMemory menu entries. Native eligibility,
frame security checks, origin matching, and user selection still apply. Existing
field-focus suggestions on username and password fields remain native.

Chromium's `fill-on-account-select` feature defaults on, so eligible saved logins
are offered for selection rather than filled on page load. The separate native
automatic-sign-in default remains off. Existing user preferences are not reset.
Saving and filling remain separate native settings: turning off Offer to save
suppresses the save/update cue; it does not change Chromium's rules for offering
already-saved passwords.

There is no DOM credential collector, new store, password logging, provider
integration, extension permission, or extension access to credential contents.

## Confirmed source causes

The inspected source is Chromium `156.0.8078.47` plus the locked Helium patches.
All source fixtures were downloaded into `/tmp`, and patching occurred only in
temporary copies. No application, build, real profile, or password store was used.

- Helium's `core/degoogle-context-menu.patch` removes the call to
  `AutofillContextMenuManager::AppendItems`. Restoring saving alone did not
  restore this contextual filling opportunity.
- `components/password_manager/core/browser/features/password_features.cc`
  disables `kFillOnAccountSelect` by default. In `password_form_filling.cc`, an
  eligible normal login then uses `wait_for_username = false`, allowing page-load
  filling. Enabling the existing feature uses its native account-selection path.
- `ManagePasswordsPageActionController::UpdateVisibility` only showed the key
  icon and tooltip. Native manual save/update fallback therefore had no visible
  action text. It also used the Save tooltip for pending updates. The overlay
  adds a native suggestion chip and corrects the update tooltip.
- `ChromePasswordManagerClient::IsSavingAndFillingEnabled` returns false with
  `--enable-automation`. This is an intentional upstream suppression, not removed
  here. A CDP/native prompt acceptance test must omit that switch, even when using
  a disposable profile. Merely loading a fixture with Playwright's default
  arguments cannot prove save prompts work.

The old source-evidence hash for `password_manager.cc` did not match the pinned
source reconstructed with the checked-in Helium series. GitHub and Chromium's
Gitiles mirror independently returned identical pristine bytes, SHA-256
`476a028d4c3decd58d71c917f3874031f5803c4eee6b3ae406bc86007ddc2ee6`.
Applying the checked-in `inox-patchset/modify-default-prefs.patch` produces
`f736e307485cdb34b98cbbe51c17f42b6da7100177cdeaa367fa9e30f199dca5`.
`upstream.json` now records that reproducible pre-overlay hash and the added
source evidence. This hash correction changes no source behavior.

Primary source locations:

- https://chromium.googlesource.com/chromium/src/+/156.0.8078.47/components/password_manager/core/browser/features/password_features.cc
- https://chromium.googlesource.com/chromium/src/+/156.0.8078.47/components/password_manager/core/browser/password_form_filling.cc
- https://chromium.googlesource.com/chromium/src/+/156.0.8078.47/chrome/browser/ui/passwords/manage_passwords_ui_controller.cc
- https://chromium.googlesource.com/chromium/src/+/156.0.8078.47/chrome/browser/ui/autofill/autofill_context_menu_manager.cc

## Automated verification

```sh
node --test tests/passwords.test.mjs
BREEZER_PASSWORD_SOURCE=/path/to/disposable/pinned-source-fixture \
  PYTHONDONTWRITEBYTECODE=1 python3 tests/passwords_native_test.py -v
BREEZER_PASSWORD_SOURCE=/path/to/disposable/pinned-source-fixture \
  PYTHONDONTWRITEBYTECODE=1 python3 tests/passwords_proactive_test.py -v
```

The source tests read named files from the supplied fixture, make temporary
copies, and only patch the copies. Without the environment variable, native
source tests explicitly skip. Neither suite launches or compiles Chromium.

The new five-test suite was run against both the committed old overlay and this
change with the same pinned Helium fixture. Old: four failures and one pass.
New: five passes. Its guard test evaluates the shipped boolean condition over
512 dummy-state combinations. This is a source/configuration regression check,
not native execution. The existing eight native-source tests and four Node
action tests also pass.

## Integration for Main

No shared settings, CSS, HTML, AI, or native workspace/frame files changed.
Existing preparation already fingerprints and applies everything under
`features/passwords/native-ui/`. The overlay now stages ten native targets. It
still refuses drift and supports an interrupted retry.

The native overlay fingerprint changes. The existing build wrapper deliberately
refuses mismatched preparation markers. Main should use its normal fresh-stage
workflow or a separately verified migration. Do not rewrite a marker to make an
old compiled output appear current.

To include the new source regressions in the existing shared
`script/check_breezer_passwords.py`, Main can apply this exact integration:

1. Add `import os`, `import subprocess`, and `import sys`.
2. Replace its `prepare(tree, offline=args.offline, wanted_paths=paths)` call with:

```python
        evidence = {
            'chrome/browser/password_manager/chrome_password_manager_client.cc',
            'components/password_manager/core/browser/password_form_filling.cc',
            'components/password_manager/core/browser/password_bubble_experiment.cc',
            'chrome/browser/ui/autofill/autofill_context_menu_manager.cc',
        }
        prepare(tree, offline=args.offline, wanted_paths=set(paths) | evidence)
```

3. After `assert hashes(tree, paths) == installed` and before deliberately
   corrupting the drift-test target, add:

```python
        subprocess.run(
            [sys.executable, str(ROOT / 'tests/passwords_proactive_test.py'), '-v'],
            env={**os.environ, 'BREEZER_PASSWORD_SOURCE': str(tree),
                 'PYTHONDONTWRITEBYTECODE': '1'},
            check=True,
        )
```

That check uses only temporary source fixtures already handled by the shared
checker. It needs the four additional source files in its offline fixture cache.

In the shared `docs/passwords.md`, replace `stages all five files` with
`stages all ten files` and link this document for the new native behavior and
source-only regression checks.

## Still requires Main's native acceptance

Compilation, layout/visibility in Breezer's native toolbar and app windows,
chip clicks, focus suggestions, context-menu selection, successful/failed AJAX
and navigation logins, password changes, encryption and Keychain prompts are
unverified at runtime. Main should test only disposable profiles and dummy
credentials, with save enabled/disabled, never-save sites, repeated dismissals,
private windows, and same-origin/cross-origin frames. Confirm that initial page
load does not fill credentials, selecting a suggestion does not submit a form,
and dismissing or switching tabs does not reopen a modal. No runtime acceptance
is claimed by the source tests.
