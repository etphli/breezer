import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PORT_NAME, MAX_SITES, daysUntil, normalizeView, organatoState, parseDue, relativeDay, requestView, safeUrl, urgency,
} from '../../features/ai/extension/newtab.js';

const dir = new URL('../../features/ai/extension/', import.meta.url);
const read = (name) => readFileSync(new URL(name, dir), 'utf8');

test('new tab files never parse HTML from strings or load remote resources', () => {
  for (const name of ['newtab.html', 'newtab.css', 'newtab.js']) {
    const source = read(name);
    assert.doesNotMatch(source, /\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function\(/, name);
    assert.doesNotMatch(source, /@import|@font-face|url\(\s*['"]?https?:/i, name);
    const remote = [...source.matchAll(/https?:\/\/[^\s'"`)]+/g)].map((match) => match[0]).filter((url) => url !== 'http://www.w3.org/2000/svg');
    assert.deepEqual(remote, [], `${name} references remote URLs`);
  }
  const html = read('newtab.html');
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/, 'no inline scripts');
  assert.doesNotMatch(html, /\son[a-z]+=/i, 'no inline event handlers');
  assert.doesNotMatch(html, /\sstyle=/i, 'no inline styles');
  assert.match(html, /<script type="module" src="newtab\.js"><\/script>/);
  assert.match(html, /href="workspace\.html#\/settings"/);
});

test('tone tokens stay identical to the workspace palette', () => {
  const tokens = (source) => Object.fromEntries([...source.matchAll(/^(\[data-scheme="dark"\]\s*)?(?:\[data-scheme="dark"\])?\[data-tone="(\w+)"\][^{]*\{([^}]*)\}/gm)]
    .map((match) => [`${match[0].includes('dark') ? 'dark' : 'light'}:${match[2]}`, match[3].replace(/\s+/g, ' ').trim()]));
  const workspace = tokens(read('workspace.css'));
  const newtab = tokens(read('newtab.css'));
  assert.equal(Object.keys(newtab).length, 12);
  assert.deepEqual(newtab, workspace);
});

test('only http(s) URLs survive', () => {
  assert.equal(safeUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.equal(safeUrl('http://localhost:3000'), 'http://localhost:3000/');
  for (const bad of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'chrome://settings', 'file:///etc/hosts', 'not a url', '', null, 42]) {
    assert.equal(safeUrl(bad), null, String(bad));
  }
});

test('normalizeView drops unsafe and duplicate sites and caps the row', () => {
  const topSites = [
    { title: '  Docs  ', url: 'https://docs.example.com/' },
    { title: 'Again', url: 'https://docs.example.com/' },
    { title: 'Bad', url: 'javascript:alert(1)' },
    { url: 'https://www.news.example.org/today' },
    ...Array.from({ length: 12 }, (_, i) => ({ title: `Site ${i}`, url: `https://s${i}.example.com/` })),
  ];
  const view = normalizeView({ topSites });
  assert.equal(view.topSites.length, MAX_SITES);
  assert.deepEqual(view.topSites.slice(0, 2), [
    { url: 'https://docs.example.com/', title: 'Docs' },
    { url: 'https://www.news.example.org/today', title: 'news.example.org' },
  ]);
});

test('normalizeView keeps Organato enabled by default and sorts by due date', () => {
  const view = normalizeView({ organato: {
    connected: true,
    assignments: [
      { id: 'b', title: 'Later', dueAt: '2026-11-10T09:00:00Z' },
      { id: 'x', title: '   ' },
      { id: 'a', title: 'Sooner <img src=x>', dueAt: '2026-11-01', subject: 'Biology', url: 'javascript:void 0' },
      'nonsense',
    ],
    todos: [{ title: 'Undated' }, { title: 'Dated', dueAt: '2026-10-30' }],
  } });
  assert.equal(view.organato.enabled, true);
  assert.deepEqual(view.organato.assignments.map((item) => item.title), ['Sooner <img src=x>', 'Later']);
  assert.equal(view.organato.assignments[0].url, null);
  assert.equal(view.organato.assignments[0].allDay, true);
  assert.deepEqual(view.organato.todos.map((item) => item.title), ['Dated', 'Undated']);
  assert.deepEqual(view.organato.exams, []);
  assert.deepEqual(normalizeView(null).topSites, []);
});

test('organatoState covers every state the section can show', () => {
  const base = normalizeView({ organato: {} }).organato;
  assert.equal(organatoState(null), 'unavailable');
  assert.equal(organatoState({ ...base, enabled: false }), 'disabled');
  assert.equal(organatoState(base), 'setup');
  assert.equal(organatoState({ ...base, connected: true }), 'ready');
  assert.equal(organatoState({ ...base, connected: true, error: 'Key rejected' }), 'error');
  assert.equal(organatoState({ ...base, connected: true, error: 'Timed out', exams: [{}] }), 'ready');
});

test('date-only due values are local days and relative labels read plainly', () => {
  const due = parseDue('2026-10-30');
  assert.deepEqual([due.getFullYear(), due.getMonth(), due.getDate(), due.getHours()], [2026, 9, 30, 0]);
  assert.equal(parseDue('soon'), null);
  const now = new Date(2026, 9, 29, 23, 30);
  assert.equal(daysUntil(due, now), 1);
  assert.equal(daysUntil(new Date(2026, 9, 29, 0, 5), now), 0);
  assert.deepEqual([0, 1, -1, -3, 5].map(relativeDay), ['Today', 'Tomorrow', 'Due yesterday', '3 days overdue', 'In 5 days']);
  assert.deepEqual([null, -2, 0, 2, 9].map(urgency), ['none', 'overdue', 'today', 'soon', 'later']);
});

function fakeApi(respond) {
  const sent = [];
  let disconnected = 0;
  return {
    sent,
    get disconnected() { return disconnected; },
    runtime: {
      connect({ name }) {
        const listeners = { message: [], disconnect: [] };
        return {
          name,
          onMessage: { addListener: (fn) => listeners.message.push(fn) },
          onDisconnect: { addListener: (fn) => listeners.disconnect.push(fn) },
          postMessage(message) {
            sent.push({ name, message });
            respond(message, {
              reply: (value) => setTimeout(() => listeners.message.forEach((fn) => fn(value)), 0),
              drop: () => setTimeout(() => listeners.disconnect.forEach((fn) => fn()), 0),
            });
          },
          disconnect() { disconnected += 1; },
        };
      },
    },
  };
}

test('requestView sends one view request on the breezer-newtab port and closes it', async () => {
  const api = fakeApi((message, port) => {
    port.reply({ type: 'view', id: 'someone-else', topSites: [] });
    port.reply({ type: 'view', id: message.id, topSites: [{ title: 'A', url: 'https://a.example/' }] });
  });
  const answer = await requestView(api, { refresh: true });
  assert.equal(api.sent.length, 1);
  assert.equal(api.sent[0].name, PORT_NAME);
  assert.equal(api.sent[0].message.type, 'view');
  assert.equal(api.sent[0].message.refresh, true);
  assert.equal(answer.topSites[0].url, 'https://a.example/');
  assert.equal(api.disconnected, 1);
});

test('requestView fails cleanly on disconnect, timeout or a missing runtime', async () => {
  await assert.rejects(requestView(fakeApi((_, port) => port.drop())), /closed the connection/);
  await assert.rejects(requestView(fakeApi(() => {}), { timeoutMs: 20 }), /too long/);
  await assert.rejects(requestView({}), /not available/);
});
