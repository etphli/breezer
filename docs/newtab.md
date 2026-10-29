# Breezer new tab

`features/ai/extension/newtab.{html,css,js}` replace the blank Chromium new tab
with two things: one row of frequently visited sites around the upper third of
the window, and an Organato section with two lists: Upcoming (exams and
assignments together, in date order) and To-dos.

## Saved shortcuts and task links

The Add shortcut tile follows the sites row. Its popover accepts a web address
or an open http(s) tab. Arrow keys select a tab and Enter adds it. Escape and
clicking outside close the popover. Saved shortcuts persist in extension-local
storage and use the same remove, Undo and Restore controls as recommendations.
The row reserves space for saved shortcuts and the Add tile on smaller windows.

The native Organato helper supplies `https://organato.vercel.app/items/<id>`
links so assignment titles open their task inside Organato.

## Design

- **Sky and sheet.** The top of the page is the profile's Breezer tone (`--air`)
  and holds today's date and the row of sites. Below it a rounded sheet
  (`--card`) rises from the bottom edge and holds "Coming up in Organato". The sheet's
  position is fixed by the reserved row height, so nothing jumps while loading
  or when there are no sites.
- **Type.** The system serif (`ui-serif`, New York on macOS) for the date,
  section title and the date numerals; the system sans for everything else. No
  web fonts, so nothing is fetched.
- **One loud element.** Each Organato row starts with a tear-off calendar stub:
  the day of the month in large serif numerals, the weekday below. Its colour
  carries urgency: accent for today and the next three days, the danger colour
  when overdue, muted otherwise, and an empty ring for to-dos with no date.
- **Two lanes.** Upcoming (the wider column) and To-dos sit side by side on
  wide windows and stack below 860 px. Upcoming shows the eight soonest items
  and To-dos the six soonest, then "N more in Organato". Exams have no lane of
  their own: an exam row carries a quiet bold "Exam" beside its date, so there
  are no competing Exams/Assignments headings.
- **One row of sites, always.** Up to 8 sites; 6 below 920 px, 4 below 700 px
  and 3 below 400 px. Hidden tiles use `display: none`, so they are out of the
  tab order too.
- **Motion.** The lanes settle in once when Organato's answer arrives, and the
  refresh icon spins while a request is in flight. Both are off under
  `prefers-reduced-motion`.
- **Theme.** `panel-theme.js` applies the profile's tone and colour mode from
  `chrome.breezerPrivate.getAppearance` and follows changes; without the bridge
  the page follows the OS light/dark setting. Tone tokens are copied from
  `workspace.css`; `tests/ai/newtab.test.mjs` fails if they drift.

## States

| Organato section | When | Shows |
| --- | --- | --- |
| Loading | Before the first answer | "Loading your exams, assignments and to-dos…", `aria-busy`; 8 placeholder tiles in the sites row |
| Ready | `connected` or items present | The two lanes. A non-empty `error` with items present shows "Showing the last update…" above them |
| Setup | `enabled` and not `connected`, no items | "Connect Organato…" and a link to Settings |
| Error | `error` set, no items | The error text and a link to Settings |
| Off | `enabled: false` | "Organato is turned off." and a link to Settings |
| Unavailable | No answer, port closed, or 8 s timeout | What went wrong and "Press Refresh to try again" |

Every Settings link is `workspace.html#/settings`.

## Background contract (`breezer-newtab` port)

The page never makes HTTP requests. It stores shortcut preferences locally. Main's background
script owns persistence, the Organato API key and every network call.

Request: the page calls `chrome.runtime.connect({ name: 'breezer-newtab' })`
and posts exactly one message:

```js
{ type: 'view', id: string, refresh: boolean }
```

`refresh` is `false` on page load and `true` when the person presses Refresh.
The background may serve a cached answer when `refresh` is `false`.

Response: one message on the same port, echoing `id`:

```js
{
  type: 'view',
  id,                       // from the request
  topSites: [{ title, url }],
  organato: {
    enabled: boolean,       // anything but false counts as on (the default)
    connected: boolean,     // an API key is saved and the last call succeeded
    error: string | null,   // short, user-readable; never a key or token
    exams: [Item],
    assignments: [Item],
    todos: [Item],
  },
}

Item = {
  id: string,
  title: string,            // Organato displayName
  dueAt: string | null,     // ISO 8601 date-time, or 'YYYY-MM-DD' for an all-day local date
  allDay?: boolean,         // true hides the time (implied by a 'YYYY-MM-DD' dueAt)
  subject?: string | null,  // subject display or short name
  url?: string | null,      // http(s) only; the helper supplies the Organato task URL
}
```

The page closes the port after the first matching answer, on disconnect, or
after 65 seconds. It sends one request on load and one per Refresh press, with
at most one in flight; it never polls. At midnight it repaints "Today" and
"Tomorrow" from the answer it already has.

All received values are treated as untrusted: text is set with `textContent`
and trimmed (titles to 200 characters, errors to 240), only `http:`/`https:`
URLs become links, duplicate site URLs are dropped, and lists are sorted by due
date with undated items last.

### Upcoming and To-dos (merged in the page)

The background contract above is unchanged; the page combines the arrays in
`normalizeView`:

- **Upcoming** is `exams` followed by `assignments`, sorted together by due
  date. An item appears once per Organato `id`, even when it arrives in both
  arrays (Organato `classification: 'both'`) or twice in one. If any copy came
  from `exams`, the row is tagged "Exam".
- **To-dos** is `todos`, deduplicated by `id` the same way. A to-do never
  appears in Upcoming: anything with `kind: 'todo'` and any `id` that is also
  in `todos` is left out of Upcoming.
- Only a real `id` (a string or number) can match two rows. Items with
  different IDs stay separate even when their titles are identical, and items
  without an ID are never merged.

## Integration notes for Main

- The three files are not yet wired up. Main needs to add
  `"chrome_url_overrides": { "newtab": "newtab.html" }` (or the native
  equivalent), the `breezer-newtab` port handler, and the Organato settings.
- `script/apply_breezer_ai.py` caps the extension at 20 resources. Adding these
  three files makes 23, so the GRIT reservation must grow before
  `apply_breezer_ai.py` will accept them.
- Favicons come from the extension's `/_favicon/` endpoint (the manifest already
  has the `favicon` permission). If it fails, a serif monogram stays in place.
- Organato's `kind: 'todo'` items map to `todos`. How exams and assignments
  are told apart (for example `classification: 'checkpoint'`) is Main's choice;
  overlap between the arrays is harmless because the page merges by `id`.

## Tests

- `node --test tests/ai/newtab.test.mjs`: no HTML parsing or remote URLs,
  tone tokens match `workspace.css`, URL filtering, normalization, state
  selection, date handling, the Upcoming merge (an item classified as both
  shows once, to-dos stay out of Upcoming, same titles with different IDs stay
  separate, chronological order) and the port request/timeout/disconnect
  behaviour.
- `node --test tests/ai/newtab-bridge.test.mjs`: runs the real background
  handler and checks that its overlapping arrays render as one Upcoming list.
- `node --test tests/ai/newtab-browser.test.mjs`: drives `newtab.html` in
  headless Chrome against a `chrome.*` fixture. It checks every state, the
  single-row layout, the two lanes with each item shown once, a stale refresh
  error that keeps the last items, Refresh, keyboard order, the theme bridge and OS fallback,
  narrow widths, and hostile input. It writes screenshots to
  `$BREEZER_AI_EVIDENCE` (default `/tmp/breezer-ai-evidence`). Sites and
  items in the fixture are test data.

Frequently visited shortcuts can be hidden with their Remove button or the right-click menu. Normal, keyboard and modifier clicks keep immediate native link behaviour. Undo and Restore shortcuts reverse the local preference. Hiding stores only hashed URLs in `chrome.storage.local`, and never deletes browsing history or bookmarks. Hidden sites are filtered before the eight visible slots are chosen.
