import { readFile, mkdtemp, copyFile, chmod, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';

export const REPO = 'etphli/breezer';
const API = `https://api.github.com/repos/${REPO}`;
const HOST = dirname(fileURLToPath(import.meta.url));
export function validateManifest(value, release) {
  if (value?.schema !== 1 || value.platform !== 'darwin-arm64' || !/^[a-f0-9]{40}$/.test(value.commit) || !/^[a-f0-9]{64}$/.test(value.sha256)) throw new Error('This release has invalid update metadata.');
  const asset = release.assets?.find(a => a.name === value.asset);
  const expected = `https://github.com/${REPO}/releases/download/${encodeURIComponent(release.tag_name)}/${encodeURIComponent(value.asset)}`;
  if (!asset || !/^Breezer[^/]*\.dmg$/.test(value.asset) || asset.browser_download_url !== expected || !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > 4 * 1024 ** 3) throw new Error('This release has no supported Breezer download.');
  if (asset.digest && asset.digest !== `sha256:${value.sha256}`) throw new Error('Release checksums disagree.');
  return { ...value, url: expected, size: asset.size, version: release.tag_name };
}
export async function githubJSON(url, fetcher = fetch) {
  const response = await fetcher(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Breezer-Updater', 'X-GitHub-Api-Version': '2022-11-28' }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(response.status === 403 || response.status === 429 ? 'GitHub is limiting update checks. Try again later.' : `Update check failed (${response.status}).`);
  const text = await response.text();
  if (text.length > 2_000_000) throw new Error('Update response is too large.');
  return JSON.parse(text);
}
export async function checkRelease(current, fetchJSON = githubJSON) {
  if (!/^[a-f0-9]{40}$/.test(current?.commit)) throw new Error('This build has no update identity. Install a current Breezer release first.');
  const release = await fetchJSON(`${API}/releases/latest`);
  if (release.draft || release.prerelease) throw new Error('No stable update is available.');
  const metadata = release.assets?.find(a => a.name === 'breezer-update.json');
  const metadataURL = `https://github.com/${REPO}/releases/download/${encodeURIComponent(release.tag_name)}/breezer-update.json`;
  if (!metadata || metadata.browser_download_url !== metadataURL) return { available: false, notice: 'The latest release does not support in-app updates yet.' };
  const candidate = validateManifest(await fetchJSON(metadataURL), release);
  if (candidate.commit === current.commit) return { available: false, notice: 'Breezer is up to date.' };
  const comparison = await fetchJSON(`${API}/compare/${current.commit}...${candidate.commit}`);
  if (comparison.status !== 'ahead') return { available: false, notice: 'Your build is current or newer than the latest stable release.' };
  return { available: true, candidate };
}

export class UpdateController {
  constructor(send) { this.send = send; this.busy = false; this.candidate = null; }
  async receive(message) {
    const id = message.id;
    if (this.busy) { this.send({ type: 'update-result', id, ok: false, error: 'An update operation is already running.' }); return; }
    this.busy = true;
    try {
      if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('In-app updates currently support Apple Silicon Macs.');
      if (message.type === 'update-status') {
        const end = HOST.indexOf('/Breezer.app/');
        const parent = dirname(HOST.slice(0, end + '/Breezer.app'.length));
        let value = {};
        try { value = JSON.parse(await readFile(join(parent, '.Breezer-update-status.json'), 'utf8')); } catch {}
        this.send({ type: 'update-result', id, ok: true, value }); return;
      }
      const current = JSON.parse(await readFile(join(HOST, 'build-identity.json'), 'utf8'));
      if (message.type === 'update-check') {
        const result = await checkRelease(current);
        this.candidate = result.candidate || null;
        this.send({ type: 'update-result', id, ok: true, value: { available: result.available, version: result.candidate?.version, notice: result.notice, current: current.commit.slice(0, 8) } });
      } else if (message.type === 'update-install') {
        if (!this.candidate) throw new Error('Check for updates before installing.');
        const result = await checkRelease(current);
        if (!result.available || JSON.stringify(result.candidate) !== JSON.stringify(this.candidate)) throw new Error('The release changed. Check for updates again.');
        const appEnd = HOST.indexOf('/Breezer.app/');
        if (appEnd < 0) throw new Error('Run the installed Breezer app to update.');
        const app = HOST.slice(0, appEnd + '/Breezer.app'.length);
        if (![join(homedir(), 'Applications/Breezer.app'), '/Applications/Breezer.app'].includes(app)) throw new Error('Move Breezer to Applications before updating.');
        // Keep the worker and its runtime outside the app that it replaces.
        const work = await mkdtemp(join(dirname(app), '.breezer-update-'));
        await copyFile(process.execPath, join(work, 'node')); await chmod(join(work, 'node'), 0o700);
        await copyFile(join(HOST, 'update-worker.mjs'), join(work, 'worker.mjs'));
        await writeFile(join(work, 'request.json'), JSON.stringify({ app, candidate: this.candidate }), { mode: 0o600 });
        const child = spawn(join(work, 'node'), [join(work, 'worker.mjs'), work], { detached: true, stdio: 'ignore' });
        await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); }); child.unref();
        this.candidate = null;
        this.send({ type: 'update-result', id, ok: true, value: { installing: true, notice: 'Downloading update. Breezer will close and reopen when it is ready. Your tabs and profile are preserved.' } });
      }
    } catch (error) { this.send({ type: 'update-result', id, ok: false, error: error.message }); }
    finally { this.busy = false; }
  }
}
