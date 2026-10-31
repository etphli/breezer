# Website and usage measurements

The canonical public site is https://breezer-browser.vercel.app. Vercel builds
`site/` from GitHub `main`. `getbreezer.vercel.app` is another public alias.

## Pages and visual direction

The privacy page borrows the readable introduction, sticky contents navigation,
revision dates, and long-form sections of https://t3.codes/privacy-policy. Its
copy is original and describes Breezer's actual behavior. It uses Breezer's
paper `#fcf8ef`, ink `#1e2a2a`, teal `#1d5458`, mint `#8fd5c4`, and muted
`#59625f`, with New York/Iowan display type and system sans-serif body type.

The dashboard uses pale sage `#eaf1ee`, white, dark green `#203c3b`, and the
existing browser icon. A narrow left navigation anchors three comparable
measurements, a 30-day time chart, and a release table. Content aligns left;
numbers use tabular figures. Empty, loading, and failed states contain no
invented activity. Small screens stack the measurements and retain a data table
as an accessible alternative to the chart.

## Access boundary

The private dashboard is
https://breezer-ethans-project.vercel.app/dashboard. This exact team alias is
protected by the project's Vercel Authentication setting
`all_except_custom_domains`. Vercel authenticates requests before invoking the
functions. `api/dashboard.js` and `api/metrics.js` accept only this exact Host;
forwarded host headers do not grant access. Public dashboard requests redirect
to the protected alias; public metrics requests return 404. Do not make this
alias a public production domain or disable deployment protection. Test the
unauthenticated boundary after any hosting change. Private data responses are
never cached. The page has noindex and a restrictive CSP.

## What the numbers mean

- Installer downloads sum GitHub `.dmg` asset download counts across published
  releases, including prereleases. They count transfers, not installations or
  unique people. Updates and repeated downloads may count again.
- MAU counts distinct reporting identifiers in the current UTC calendar month.
  Identifiers rotate each month, so this avoids misleading cross-month
  deduplication. Multiple profiles and reinstallations can overcount people.
- Hours sum reported active seconds over the last 30 UTC dates, including today.
  The browser samples once a minute while a non-private regular window is
  focused and the machine is active. Gaps over 90 seconds, sleep, private
  windows, idle time, and background time are excluded. Sampling and batching
  can undercount, especially short sessions.

Usage reporting is on by default as requested by the maintainer. Settings →
Privacy and usage disables future reporting, aborts an in-flight request where
possible, clears the alarm, and removes local counters. Re-enabling generates a
new ID. Already received reports expire normally. Older releases do not report.
The installed app is not updated by these source changes.

## Collection and storage

`features/ai/extension/usage.js` stores a random UUID, a UTC month, daily second
totals, and local sampling/batch timestamps in `chrome.storage.local`. The
payload contains only `{month, id, days}`. It sends at most every 30 minutes
after the initial active report. It never reads tab URLs or page content.

`POST /api/usage` validates the exact schema, identifier, dates, and 4 KiB limit.
The collector is public because distributed clients cannot hold a secret.
Reports are therefore product estimates, not trustworthy billing or security
events. Deliberately forged clients can inflate counts. Strict body limits,
one blob per monthly ID, a per-ID write interval, and Vercel's platform controls
limit some abuse; they do not prevent forged new IDs. Monitor Blob quotas and
request volume before wider distribution. The Hobby account has no paid-plan
upgrade in this setup.

The private `breezer-usage` Vercel Blob store supplies `BLOB_READ_WRITE_TOKEN` to
server functions in production and preview. No read token reaches the browser.
Each ID owns one monthly object. Incoming cumulative daily counters merge by
maximum, with ETag conditional writes and bounded retries; retries and stale
reports cannot double-count or overwrite newer totals. Reports are read with
the storage cache bypassed. Dashboard reads paginate and use bounded parallel
fetches; more than 20,000 reports fails visibly rather than returning partial
totals. A larger audience should move aggregation to a transactional database.

The daily `0 4 * * *` retention job keeps only current and previous calendar
months. Raw reports therefore expire within 63 days allowing for the daily job.
Set a server-only `CRON_SECRET` in production. Vercel adds the Bearer credential
to scheduled invocations. Cleanup fails closed without it. Operational logs
have separate provider retention. Configure alerts for failed cleanup jobs.

## Verification

```sh
cd site
npm ci --ignore-scripts
npm test
cd ..
node --test tests/ai/usage.test.mjs tests/ai/settings.test.mjs
python3 -m unittest discover -s tests/ai -p overlay_test.py
python3 script/check_ai_overlay.py --offline
```

The browser test uses installed Chrome and the Playwright dependency in
`tests/ai/node_modules`. Screenshots go to `/tmp/breezer-site-evidence` or
`BREEZER_SITE_EVIDENCE`. Its data and extension APIs are fixtures; it checks the
shipped DOM, controls, charts, responsive layouts, and failure handling. It is
not a native Breezer build or a real-user activity measurement. Live hosting
checks separately verify public access, private redirects, denied metrics
access, download counts, and real private Blob writes/deletes.
