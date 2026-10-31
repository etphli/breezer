// Renders the Breezer ads to MP4.
//
//   node advertising/src/render.mjs [01-blink ...]
//
// Needs Google Chrome, playwright-core and an ffmpeg build with libx264.
// Set AD_TOOLS to a directory holding node_modules/playwright-core and an
// ffmpeg binary, or install playwright-core locally and put ffmpeg on PATH.
// Frames stream straight into ffmpeg; nothing is written to disk except the
// finished video and a temporary soundtrack.

import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, "..");
const tools = process.env.AD_TOOLS;
const require = createRequire(tools ? path.join(tools, "package.json") : import.meta.url);
const { chromium } = require("playwright-core");
const ffmpeg = tools ? path.join(tools, "ffmpeg") : "ffmpeg";
const chrome = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const concurrency = Number(process.env.AD_JOBS || 2);

const run = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "inherit", "pipe"], ...opts });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}\n${err.slice(-2000)}`))));
    if (opts.feed) opts.feed(child.stdin);
  });

async function renderAd(browser, name) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(path.join(here, `${name}.html`)).href + "?render");
  await page.waitForFunction(() => window.AD && window.AD.ready, null, { timeout: 30000 });
  const { audio, fps, duration } = await page.evaluate(() => ({ audio: AD.audio, fps: AD.fps, duration: AD.duration }));

  const temp = await mkdtemp(path.join(tmpdir(), `breezer-${name}-`));
  try {
    const spec = path.join(temp, "score.json");
    const wav = path.join(temp, "score.wav");
    await writeFile(spec, JSON.stringify({ ...audio, duration }));
    await run("python3", [path.join(here, "soundtrack.py"), spec, wav]);

    const out = path.join(outDir, `breezer-${name}.mp4`);
    const frames = Math.round(fps * duration);
    const started = Date.now();
    await run(ffmpeg, [
      "-y", "-loglevel", "error",
      "-f", "image2pipe", "-framerate", String(fps), "-c:v", "mjpeg", "-i", "-",
      "-i", wav,
      "-c:v", "libx264", "-preset", "slow", "-crf", "20", "-maxrate", "5M", "-bufsize", "10M",
      "-vf", "scale=in_range=full:out_range=tv,format=yuv420p", "-color_range", "tv", "-profile:v", "high", "-tune", "film",
      "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart",
      out,
    ], {
      feed: async (stdin) => {
        for (let f = 0; f < frames; f++) {
          await page.evaluate((t) => AD.frame(t), f / fps);
          const jpg = await page.screenshot({ type: "jpeg", quality: 94 });
          if (!stdin.write(jpg)) await new Promise((r) => stdin.once("drain", r));
          if (f % 150 === 0) console.log(`${name}: frame ${f}/${frames}`);
        }
        stdin.end();
      },
    });
    console.log(`${name}: done in ${Math.round((Date.now() - started) / 1000)}s -> ${path.relative(process.cwd(), out)}`);
  } finally {
    await rm(temp, { recursive: true, force: true });
    await page.close();
  }
}

const all = (await readdir(here)).filter((f) => /^\d\d-.*\.html$/.test(f)).map((f) => f.replace(/\.html$/, "")).sort();
const wanted = process.argv.slice(2);
const names = wanted.length ? all.filter((n) => wanted.some((w) => n.startsWith(w))) : all;

const browser = await chromium.launch({
  executablePath: chrome,
  args: ["--allow-file-access-from-files", "--force-color-profile=srgb", "--hide-scrollbars"],
});
try {
  const queue = [...names];
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) await renderAd(browser, queue.shift());
  }));
} finally {
  await browser.close();
}
