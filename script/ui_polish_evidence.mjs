// Re-run the shipped UI walkthroughs and build annotated screenshot comparisons.
// node script/ui_polish_evidence.mjs capture /tmp/breezer-ui/after
// node script/ui_polish_evidence.mjs compare BEFORE AFTER OUTPUT
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve, relative, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [command, ...args] = process.argv.slice(2);
if (command === 'capture' && args.length === 1) {
  const evidence = resolve(args[0]);
  await mkdir(evidence, { recursive: true });
  const env = { ...process.env, BREEZER_AI_EVIDENCE: evidence };
  for (const tests of [
    ['--test', 'tests/ai/workspace-browser.test.mjs', 'tests/ai/workspace-frame.test.mjs', 'tests/ai/settings-redesign-browser.test.mjs', 'tests/ai/newtab-browser.test.mjs', 'tests/ai/ui-polish-browser.test.mjs'],
    ['tests/ai/panel-browser.mjs'],
  ]) execFileSync(process.execPath, tests, { cwd: root, env, stdio: 'inherit' });
} else if (command === 'compare' && [3, 4].includes(args.length)) {
  const [before, after, output] = args.slice(0, 3).map(value => resolve(value));
  await mkdir(output, { recursive: true });
  const escape = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
  const surfaces = args[3] ? JSON.parse(await readFile(resolve(args[3]), 'utf8')) : [
    { id: 'settings', title: 'Settings', file: 'settings-redesign-general-light.png', notes: [
      [15, 20, 8, 8, 'Quieter navigation with a clearer current category.'],
      [70, 5, 52, 22, 'A lighter import card and more deliberate type hierarchy.'],
      [88, 92, 76, 70, 'Consistent grouped controls, spacing and borders.'],
    ] },
    { id: 'newtab', title: 'New tab', file: 'newtab-connected-light.png', notes: [
      [15, 4, 34, 22, 'The date leads a calmer, less saturated canvas.'],
      [88, 15, 68, 32, 'Shortcut tiles have a more restrained finish.'],
      [88, 82, 71, 58, 'The agenda reads as part of the page, with less visual weight.'],
    ] },
    { id: 'assistant', title: 'Assistant', file: 'sidebar-welcome.png', notes: [
      [78, 7, 52, 17, 'A smaller welcome heading gives the narrow panel room.'],
      [82, 49, 40, 33, 'Suggestions and secondary text have clearer hierarchy.'],
      [80, 67, 58, 87, 'A quieter composer border keeps focus on writing.'],
    ] },
    { id: 'sidebar', title: 'Tabs', file: 'workspace-sidebar.png', notes: [
      [80, 12, 53, 4, 'Favorites keep their identity on a subtler background.'],
      [84, 27, 16, 31, 'A Today divider separates temporary tabs from saved pages.'],
      [84, 49, 48, 39, 'The selected tab stands apart from surrounding rows.'],
    ] },
  ];
  for (const surface of surfaces) {
    const paths = [before, after].map(folder => relative(output, resolve(folder, surface.file)));
    // Verify both images exist before writing a comparison that links to them.
    await Promise.all(paths.map(path => readFile(resolve(output, path))));
    const arrows = surface.notes.map(([x1, y1, x2, y2], index) => `<line x1="${x1}%" y1="${y1}%" x2="${x2}%" y2="${y2}%"/><circle cx="${x1}%" cy="${y1}%" r="11"/><text x="${x1}%" y="${y1}%" dy="4">${index + 1}</text>`).join('');
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${surface.title} comparison</title><style>
      body{font-family:var(--font-sans,system-ui);color:var(--foreground,#20262b);margin:0}
      h2{font-size:20px;margin:12px 0}p,li{line-height:1.5;font-size:13px}
      .pair{display:grid;grid-template-columns:1fr 1fr;gap:12px;align-items:start}
      figure{margin:0;min-width:0}figcaption{font-size:13px;margin-bottom:8px;color:var(--muted-foreground,#627078)}
      .shot{position:relative;border:1px solid var(--border,#ccd4d7);border-radius:8px;overflow:hidden}
      img{display:block;width:100%;height:auto}svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
      line{stroke:#df482f;stroke-width:3;marker-end:url(#arrow);filter:drop-shadow(0 1px 1px white)}
      circle{fill:#df482f;stroke:white;stroke-width:2}text{fill:white;font:700 12px system-ui;text-anchor:middle}
      ol{padding-left:24px;margin:12px 0}a{color:inherit}
    </style></head><body><h2>${surface.title}</h2><div class="pair">
    <figure><figcaption>Before</figcaption><div class="shot"><img src="${escape(paths[0])}" alt="${surface.title} before"/></div></figure>
    <figure><figcaption>After</figcaption><div class="shot"><img src="${escape(paths[1])}" alt="${surface.title} after"/><svg aria-label="Arrows showing the changes"><defs><marker id="arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7" fill="#df482f"/></marker></defs>${arrows}</svg></div></figure>
    </div><ol>${surface.notes.map(note => `<li>${note[4]}</li>`).join('')}</ol><p>Shipped UI rendered in Chrome with deterministic extension API fixtures. Native window integration is a separate check.</p></body></html>`;
    await writeFile(resolve(output, `comparison-${surface.id}.html`), html);
  }
  console.log(`Comparisons written to ${output}`);
} else if (command === 'png' && args.length === 1) {
  const { chromium } = await import('../tests/ai/node_modules/playwright/index.mjs');
  const output = resolve(args[0]);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BREEZER_TEST_BROWSER || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined) });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 1 });
    for (const file of (await readdir(output)).filter(file => file.startsWith('comparison-') && file.endsWith('.html'))) {
      await page.goto(pathToFileURL(resolve(output, file)).href);
      await page.screenshot({ path: resolve(output, file.replace(/\.html$/, '.png')), fullPage: true });
    }
  } finally { await browser.close(); }
} else {
  throw new Error('Usage: ui_polish_evidence.mjs capture DIRECTORY | compare BEFORE AFTER OUTPUT [SPEC.json] | png DIRECTORY');
}
