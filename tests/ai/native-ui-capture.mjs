// Usage: node tests/ai/native-ui-capture.mjs /absolute/Breezer.app /absolute/evidence
// Captures the compiled app's own window through ScreenCaptureKit, including
// native tabs and toolbar. It never changes the installed bundle or real profile.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from './node_modules/playwright/index.mjs';

const [app, output, ...extra] = process.argv.slice(2);
assert.ok(app?.startsWith('/') && app.endsWith('/Breezer.app') && output?.startsWith('/') && !extra.length,
  'Pass absolute paths to Breezer.app and a new evidence directory.');
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const extensionOrigin = 'chrome-extension://namgcidocfgliiedlkdafcmifpdfiakj';
const executable = join(app, 'Contents/MacOS/Breezer');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
const wait = ms => new Promise(done => setTimeout(done, ms));
async function until(label, read, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await read(); if (value) return value; await wait(50); }
  throw new Error(`Timed out waiting for ${label}`);
}

const resume = process.env.BREEZER_NATIVE_RESUME === '1';
const previous = resume ? JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8')) : null;
if (!resume) await mkdir(output); // Refuse to overwrite an earlier evidence pack.
const scratch = await mkdtemp(join(tmpdir(), 'breezer-ui-native-owned-'));
const profile = join(scratch, 'profile');
await mkdir(join(profile, 'Default'), { recursive: true });
await writeFile(join(profile, 'Default/Preferences'), JSON.stringify({
  breezer: { workspace: { initialized: true } },
  helium: { browser: { layout: 0, zen_mode: false, centered_location_bar: false, minimal_location_bar: false } },
}));
const frameworkVersion = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', join(app, 'Contents/Info.plist')], { encoding: 'utf8' }).trim();
const resources = join(app, 'Contents/Frameworks/Breezer Framework.framework/Resources');
const identity = JSON.parse(await readFile(join(resources, 'breezer_ai/host/build-identity.json'), 'utf8'));
assert.match(identity.commit, /^[0-9a-f]{40}$/);
const inputNames = git('ls-files', 'features/workspace/native', 'features/ai/native-ui', 'script/apply_breezer_workspace.py', 'script/breezer_sidebar_frame.py', 'script/apply_breezer_ai_ui.py').split('\n').filter(Boolean);
assert.equal(git('rev-parse', 'HEAD:upstream/helium-macos'), git('rev-parse', `${identity.commit}:upstream/helium-macos`), 'Native upstream source tree changed');
const nativeInputs = [];
for (const name of inputNames) {
  const bytes = await readFile(join(repo, name));
  const original = execFileSync('git', ['show', `${identity.commit}:${name}`], { cwd: repo });
  assert.equal(sha(bytes), sha(original), `${name} changed since the installed native runtime's reported source commit`);
  nativeInputs.push({ path: name, sha256: sha(bytes) });
}
const pins = [executable, join(app, 'Contents/Frameworks/Breezer Framework.framework/Breezer Framework'), join(resources, 'breezer_ai/host/build-identity.json')];
const installedBefore = await Promise.all(pins.map(async path => ({ path, sha256: sha(await readFile(path)) })));
if (previous) {
  assert.deepEqual(previous.nativeInputs, nativeInputs);
  assert.deepEqual(previous.installedPins, installedBefore.map(({ path, sha256 }) => ({ path, sha256 })));
  assert.equal(previous.cleanup.liveRecordedProcesses.length, 0);
  for (const capture of previous.captures) assert.equal(sha(await readFile(capture.path)), capture.sha256, 'Resume evidence changed');
}
const hook = join(scratch, 'capture.dylib');
execFileSync('clang++', ['-dynamiclib', '-fobjc-arc', '-framework', 'Cocoa', '-framework', 'ScreenCaptureKit', '-framework', 'ImageIO', '-framework', 'CoreMedia', '-o', hook, join(repo, 'tests/ai/native-window-capture.mm')]);
const captureEnv = { ...process.env, DYLD_INSERT_LIBRARIES: hook, BREEZER_UI_NATIVE_CAPTURE_DIR: scratch };
// Exercise both the ordinary spawn path and the native-account isolation guard
// before injecting the same library into a browser.
execFileSync(process.execPath, ['-e', `const {spawnSync}=require('node:child_process'); const a=require('node:assert/strict'); a.equal(spawnSync('/usr/bin/true').status,0); a.equal(spawnSync('/tmp/fixture/breezer_ai/host/launch.sh').error?.code,'EPERM');`], { env: captureEnv });

const server = createServer((req, res) => {
  const name = req.url === '/notes' ? 'Field notes' : req.url === '/reading' ? 'Reading list' : 'Today';
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><title>${name} · Breezer fixture</title><style>body{margin:0;padding:48px;background:#e4f3ed;color:#173c35;font:18px system-ui}h1{font:44px Georgia}</style><h1>${name}</h1><p>Fictional content for native UI review.</p>`);
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;
const reducedMotion = process.env.BREEZER_NATIVE_REDUCED_MOTION === '1';
const motionOnly = process.env.BREEZER_NATIVE_MOTION_ONLY === '1';
if (previous) { assert.equal(previous.reducedMotionForced, reducedMotion); assert.equal(previous.motionOnly, motionOnly); }
const report = {
  startedAt: new Date().toISOString(), app, appVersion: frameworkVersion, sourceHead: git('rev-parse', 'HEAD'),
  nativeRuntimeReportedCommit: identity.commit, nativeInputs, installedPins: installedBefore.map(({ path, sha256 }) => ({ path, sha256 })),
  method: 'ScreenCaptureKit current-process window', profile, fixtureOnly: true, captures: previous?.captures || [],
  previousAttempts: previous ? [...(previous.previousAttempts || []), { startedAt: previous.startedAt, finishedAt: previous.finishedAt, status: previous.status, error: previous.error, ownedProcesses: previous.finalOwnedProcesses, cleanup: previous.cleanup }] : [],
  reducedMotionForced: reducedMotion, motionOnly,
  reducedMotionMethod: reducedMotion ? 'Chromium native animation switch plus renderer CSS preference. System accessibility settings are unchanged.' : 'Renderer CSS no-preference; native runtime uses the current system preference.',
  provenance: 'Actual installed native runtime with unchanged native workspace/frame inputs. Its packaged web UI is older; these captures verify native chrome, not the current candidate web UI. The resource commit stamp is not a reproducible binary attestation.',
};
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: executable, headless: false, viewport: null, env: captureEnv,
    reducedMotion: reducedMotion ? 'reduce' : 'no-preference',
    ignoreDefaultArgs: ['--enable-automation', '--disable-extensions', '--disable-component-extensions-with-background-pages', '--no-sandbox'],
    args: ['--no-first-run', '--no-default-browser-check', '--window-size=1100,780', '--disable-background-networking', ...(reducedMotion ? ['--force-prefers-reduced-motion'] : [])],
  });
  const worker = context.serviceWorkers().find(item => item.url() === `${extensionOrigin}/background.js`)
    || await context.waitForEvent('serviceworker', { predicate: item => item.url() === `${extensionOrigin}/background.js`, timeout: 30000 });
  const call = (name, ...args) => worker.evaluate(({ name, args }) => new Promise((done, fail) => {
    chrome.breezerPrivate[name](...args, value => chrome.runtime.lastError ? fail(new Error(chrome.runtime.lastError.message)) : done(value));
  }), { name, args });
  const pages = [];
  for (const path of ['/', '/notes', '/reading']) { const page = await context.newPage(); await page.goto(base + path); pages.push(page); }
  const page = pages[0];
  report.pagePrefersReducedMotion = await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  if (reducedMotion) assert.equal(report.pagePrefersReducedMotion, true);
  const cdp = await context.browser().newBrowserCDPSession();
  const { windowId } = await cdp.send('Browser.getWindowForTarget', { targetId: (await context.newCDPSession(page).then(session => session.send('Target.getTargetInfo'))).targetInfo.targetId });
  report.ownedProcesses = (await cdp.send('SystemInfo.getProcessInfo')).processInfo;
  report.browserPid = report.ownedProcesses.find(p => p.type === 'browser').id;
  await until('owned capture hook', async () => { try { const r = JSON.parse(await readFile(join(scratch, 'reply.json'), 'utf8')); return r.hookLoaded && r.pid === report.browserPid; } catch { return false; } });
  async function request(name, method = 'screen') {
    await rm(join(scratch, 'reply.json'), { force: true });
    await writeFile(join(scratch, 'request.tmp'), JSON.stringify({ name, method }));
    await rename(join(scratch, 'request.tmp'), join(scratch, 'request.json'));
    const result = await until('native capture reply', async () => { try { return JSON.parse(await readFile(join(scratch, 'reply.json'), 'utf8')); } catch { return false; } });
    assert.equal(result.pid, report.browserPid); assert.equal(result.ok, true, JSON.stringify(result));
    return result;
  }
  await request('prepare', 'prepare');
  const dismissStartup = async () => {
    for (const other of context.pages()) if (!pages.includes(other)) await other.close();
    await page.bringToFront();
    await page.waitForFunction(() => document.visibilityState === 'visible');
  };
  await dismissStartup();
  async function capture(name, patch, width = 1100) {
    if (report.captures.some(item => item.path === join(output, `${name}.png`))) { console.log(`retained ${name}`); return; }
    const appearance = await call('setAppearance', patch);
    for (const [key, value] of Object.entries(patch)) assert.equal(appearance[key], value, `${name}: ${key} round trip`);
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { width, height: 780, windowState: 'normal' } });
    await dismissStartup();
    let previous, result;
    for (let attempt = 0; attempt < 8; attempt++) {
      await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
      result = await request(name);
      assert.match(result.geometry.title, /Breezer fixture$/, 'The intended fictional tab is selected');
      const bytes = await readFile(result.path);
      const paint = await page.evaluate(async png => {
        const image = new Image(); image.src = `data:image/png;base64,${png}`; await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
        const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
        const sample = (x, y) => [...ctx.getImageData(x, y, 1, 1).data].slice(0, 3);
        return { width: image.width, height: image.height, corners: [sample(Math.floor(image.width * .6), image.height - 40), sample(image.width - 40, image.height - 40)], top: sample(Math.floor(image.width / 2), 30) };
      }, bytes.toString('base64'));
      const fixturePainted = paint.corners.every(pixel => pixel.every((v, i) => Math.abs(v - [228, 243, 237][i]) <= 4));
      if (!appearance.frameless) assert.ok(paint.top.some((value, i) => Math.abs(value - [228, 243, 237][i]) > 4), 'Native frame is distinct from fixture-only content');
      const hash = sha(bytes);
      if (fixturePainted && previous === hash) {
        const path = join(output, `${name}.png`); await rename(result.path, path);
        report.captures.push({ ...result, path, sha256: hash, appearance, paint, stableCaptures: attempt + 1 });
        console.log(`ok ${name} ${paint.width}x${paint.height}`); return;
      }
      previous = fixturePainted ? hash : undefined;
      await wait(150);
    }
    throw new Error(`${name}: full native window did not settle with matching fixture pixels`);
  }
  const common = { layout: 'top', frameless: false, centeredAddressBar: false, minimalUrl: false, bookmarkBarMode: 'hidden', showLoadProgress: true };
  if (!motionOnly) for (const theme of ['mint', 'tide', 'dusk', 'rose', 'pollen', 'graphite', '#2c79c7']) for (const colorMode of ['light', 'dark']) {
    const label = theme.startsWith('#') ? 'custom' : theme;
    for (const [size, width] of [['desktop', 1100], ['narrow', 540]]) await capture(`top-${label}-${colorMode}-${size}`, { ...common, theme, colorMode }, width);
  }
  if (!motionOnly) for (const [name, patch] of [
    ['toolbar-centered-minimal', { centeredAddressBar: true, minimalUrl: true }],
    ['toolbar-full-address', { centeredAddressBar: false, minimalUrl: false }],
    ['toolbar-frameless-pinned', { frameless: true, alwaysShowTopBar: true }],
    ['toolbar-frameless-auto', { frameless: true, alwaysShowTopBar: false }],
    ['toolbar-bookmarks', { frameless: false, bookmarkBarMode: 'always' }],
    ['top-system-mode', { colorMode: 'system', bookmarkBarMode: 'hidden' }],
  ]) await capture(name, { ...common, theme: 'mint', colorMode: 'light', ...patch });
  // Keep the native sidebar open while testing its frame allocation. The hosted
  // sidebar document is explicitly the installed version, not the candidate.
  if (!motionOnly) for (const sidebarMode of ['expanded', 'compact', 'autoHide']) await capture(`sidebar-frame-${sidebarMode}`, {
    ...common, layout: 'sidebar', sidebarMode, frameless: true, alwaysShowSidebar: true, alwaysShowTopBar: true,
  });
  await capture('native-motion-start', { ...common, frameless: false });
  report.recording = { start: await request('native-tabs-toolbar-motion', 'record-start'), actions: [] };
  const act = async (name, action) => { report.recording.actions.push({ name, at: new Date().toISOString() }); await action(); await wait(500); };
  await wait(300);
  await act('Select Field notes tab', () => pages[1].bringToFront());
  await act('Select Today tab', () => page.bringToFront());
  await act('Close Reading list tab', () => pages[2].close());
  await act('Enable centered, minimal address', () => call('setAppearance', { centeredAddressBar: true, minimalUrl: true }));
  report.recording.finish = await request('native-tabs-toolbar-motion', 'record-stop');
  assert.ok(report.recording.finish.durationSeconds >= 2);
  assert.ok(report.recording.finish.bytes > 0);
  const recordingPath = join(output, 'native-tabs-toolbar-motion.mp4');
  await rename(report.recording.finish.path, recordingPath);
  report.recording.path = recordingPath;
  report.recording.sha256 = sha(await readFile(recordingPath));
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = error.stack; process.exitCode = 1; console.error(error.stack);
} finally {
  if (context) report.finalOwnedProcesses = await context.browser().newBrowserCDPSession().then(c => c.send('SystemInfo.getProcessInfo')).then(x => x.processInfo).catch(() => []);
  await context?.close();
  await new Promise(done => server.close(done));
  const liveOwned = (report.finalOwnedProcesses || report.ownedProcesses || []).filter(p => spawnSync('/bin/kill', ['-0', String(p.id)]).status === 0);
  report.cleanup = { liveRecordedProcesses: liveOwned.map(p => p.id), fixturePortClosed: !server.listening };
  if (liveOwned.length) { report.status = 'failed'; report.cleanup.error = 'Owned browser processes remain; profile preserved for diagnosis'; process.exitCode = 1; }
  else { await rm(scratch, { recursive: true, force: true }); report.cleanup.profileRemoved = true; }
  report.installedPinsUnchanged = (await Promise.all(installedBefore.map(async pin => sha(await readFile(pin.path)) === pin.sha256))).every(Boolean);
  if (!report.installedPinsUnchanged) { report.status = 'failed'; process.exitCode = 1; }
  report.finishedAt = new Date().toISOString();
  await writeFile(join(output, 'manifest.json'), JSON.stringify(report, null, 2));
}
