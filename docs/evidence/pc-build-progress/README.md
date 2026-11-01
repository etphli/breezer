# PC progress square verification

Implemented by gpt-6.1-sol. The feature is prepared for future activation only.
No visible window was opened, no startup task was registered and no live build
source, output, settings or processes were changed by these tests.

`result.json` records actual Windows PowerShell 5.1.26100.9711 results:

- Six counter-test groups passed. They cover UTF8/UTF16LE/UTF16BE, incremental
  reads, partial writes, new-pass resets, truncation, terminal/failure states,
  missing/partial state, bounded reads and a quiet log.
- The entry point's fixture snapshot returned 5237 remaining from 406/5643.
- Actual native controls were constructed without displaying the form or
  enabling its timer. The normal counter measured 129 pixels wide inside a
  168-pixel client area. The five-digit 96267/96268 counter measured 155 pixels.
- Deployed source/test hashes were read back on Windows and matched local files.

The test uses synthetic files under a uniquely named folder in the PC's inactive
progress setup directory and removes that fixture folder afterward. It does not
read the live build log. Source tests are in
[`tests/windows/build-progress.test.ps1`](../../../tests/windows/build-progress.test.ps1).

No desktop screenshot is provided because the user requested future use only.
Visible rendering, DPI, dragging, desktop placement, Escape and closing the
window still need interactive acceptance on the first future activation. The
construction test is not a claim that those interactions have run.

See the [connection and activation runbook](../../pc-build.md).

## Later user activation and count-up change

The original results above describe the dormant fixture phase. Ethan later explicitly activated the desktop window and requested a count-up display. The tracked reader now shows finished/total, with remaining actions separate in the snapshot/tooltip. Count-up parser tests and visible desktop activation were verified on the configured PC; the final combined pass finished23/23. The reader still has no startup trigger and never starts a build or WSL.
