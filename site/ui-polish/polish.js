const { changes, scores } = window.breezerPolish;
const assetBase = new URL('.', document.currentScript.src || document.baseURI);
const asset = name => new URL(name, assetBase).href;
const byId = id => document.getElementById(id);
const node = (tag, content) => {
  const element = document.createElement(tag);
  if (content !== undefined) element.textContent = content;
  return element;
};
const svg = (tag, attributes = {}, content) => {
  const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  if (content !== undefined) element.textContent = content;
  return element;
};
const addOption = (select, value, title) => select.add(new Option(title, value));
const titleOf = select => select.selectedOptions[0]?.textContent;

function shot(change, label, path, annotations = []) {
  const fragment = byId('shot').content.cloneNode(true);
  fragment.querySelector('figcaption').textContent = label;
  const link = fragment.querySelector('a');
  link.href = asset(path);
  const img = fragment.querySelector('img');
  img.src = asset(path);
  img.alt = `${change.title}, ${label.toLowerCase()}. Open the full screenshot.`;
  if (!annotations.length) return fragment;

  const overlay = svg('svg', { width: '100%', height: '100%', 'aria-hidden': 'true' });
  const defs = svg('defs');
  const arrow = svg('marker', { id: 'pointer', viewBox: '0 0 10 10', refX: '8', refY: '5', markerWidth: '4', markerHeight: '4', orient: 'auto' });
  arrow.append(svg('path', { d: 'M0 0 10 5 0 10Z', fill: '#ac3628' }));
  defs.append(arrow);
  overlay.append(defs);
  for (const [index, [x1, y1, x2, y2]] of annotations.entries()) {
    overlay.append(
      svg('line', { x1: x1 + '%', y1: y1 + '%', x2: x2 + '%', y2: y2 + '%', 'marker-end': 'url(#pointer)' }),
      svg('circle', { cx: x1 + '%', cy: y1 + '%', r: 10 }),
      svg('text', { x: x1 + '%', y: y1 + '%' }, index + 1),
    );
  }
  fragment.querySelector('.shot').append(overlay);
  return fragment;
}

const surface = byId('surface');
const comparison = byId('comparison');
const list = byId('change-list');
const changeButtons = [];
for (const [index, change] of changes.entries()) {
  addOption(surface, index, change.title);
  const item = node('li');
  const button = node('button', change.title);
  button.type = 'button';
  button.addEventListener('click', () => {
    surface.value = index;
    showChange(true);
    byId('change-title').scrollIntoView({ block: 'start' });
  });
  item.append(button);
  list.append(item);
  changeButtons.push(button);
}

function showChange(reset) {
  const change = changes[Number(surface.value)];
  if (reset) {
    comparison.replaceChildren();
    addOption(comparison, 'before', 'Before this follow-up');
    if (change.original) addOption(comparison, 'original', 'Starting point');
  }
  const original = comparison.value === 'original';
  const annotations = original ? change.originalAnnotations || change.annotations : change.annotations;
  byId('change-title').textContent = change.title;
  byId('images').replaceChildren(
    shot(change, original ? 'Starting point' : 'Before', original ? change.original : change.before),
    shot(change, 'After', change.after, annotations),
  );
  byId('callouts').replaceChildren(...annotations.map(note => node('li', note[4])));
  changeButtons.forEach((button, index) => {
    if (index === Number(surface.value)) button.setAttribute('aria-current', 'true');
    else button.removeAttribute('aria-current');
  });
}
surface.addEventListener('change', () => showChange(true));
comparison.addEventListener('change', () => showChange(false));
showChange(true);

const theme = byId('theme');
const themeView = byId('theme-view');
const liveModes = new Map([
  ['mint-light', 'Mint light · live change'],
  ['tide-dark', 'Tide dark · live change'],
  ['custom-dark', 'Custom purple dark · live change'],
]);
for (const [value, label] of liveModes) addOption(theme, 'live-' + value, label);
for (const palette of ['Mint', 'Tide', 'Dusk', 'Rose', 'Pollen', 'Graphite', 'Custom']) {
  for (const mode of ['light', 'dark']) addOption(theme, `${palette.toLowerCase()}-${mode}`, `${palette === 'Custom' ? 'Custom blue' : palette} ${mode}`);
}
function showTheme() {
  const part = theme.value.startsWith('live-') && themeView.value === 'settings-appearance' ? 'settings'
    : theme.value.startsWith('live-') && themeView.value === 'sidebar-expanded' ? 'workspace' : themeView.value;
  const screenshot = byId('theme-image');
  screenshot.src = asset(`evidence/theme-${theme.value}-${part}.webp`);
  screenshot.alt = `${titleOf(themeView)} in ${titleOf(theme)}`;
  byId('theme-caption').textContent = screenshot.alt;
}
theme.addEventListener('change', showTheme);
themeView.addEventListener('change', showTheme);
showTheme();

const lineColors = ['#126e61', '#6546a7', '#a24422'];
const chart = svg('svg', { viewBox: '0 0 760 234', class: 'score-svg', role: 'img', 'aria-label': 'Design review trends by model' });
const px = round => 50 + round * 82;
const py = score => 12 + (10 - score) * 56;
for (const value of [7, 8, 9, 10]) {
  const y = py(value);
  chart.append(
    svg('line', { x1: 42, y1: y, x2: 741, y2: y, stroke: value === 9 ? '#425d67' : '#c8d8df', 'stroke-dasharray': value === 9 ? '5 5' : 'none' }),
    svg('text', { x: 15, y: y + 4 }, value),
  );
}
const legend = node('div');
legend.className = 'legend';
for (const [index, model] of scores.models.entries()) {
  const key = node('span');
  const swatch = node('i');
  swatch.style.background = lineColors[index];
  key.append(swatch, model);
  legend.append(key);
  let path = '';
  let connected = false;
  for (const [round, row] of scores.rounds.entries()) {
    const score = row[index];
    if (score === null) { connected = false; continue; }
    path += `${connected ? 'L' : 'M'}${px(round)} ${py(score)} `;
    connected = true;
  }
  chart.append(svg('path', { d: path, stroke: lineColors[index], 'stroke-width': '2.7', fill: 'none' }));
  for (const [round, row] of scores.rounds.entries()) {
    const score = row[index];
    if (score === null) continue;
    const dot = svg('circle', { cx: px(round), cy: py(score), r: '4', fill: lineColors[index], stroke: 'white' });
    dot.append(svg('title', {}, `${model}, round ${round + 1}, ${score.toFixed(1)}`));
    chart.append(dot);
  }
}
scores.rounds.forEach((row, index) => chart.append(svg('text', { x: px(index), y: 210, 'text-anchor': 'middle' }, `R${index + 1}`)));
byId('score-chart').append(legend, chart);

function scoreTable(table, description, rows) {
  const head = table.createTHead().insertRow();
  for (const label of [description, ...scores.models]) {
    const cell = node('th', label);
    cell.scope = 'col';
    head.append(cell);
  }
  const body = table.createTBody();
  for (const [label, values] of rows) {
    const row = body.insertRow();
    const heading = node('th', label);
    heading.scope = 'row';
    row.append(heading);
    for (const value of values) row.insertCell().textContent = value === null ? 'Unscored' : value.toFixed(1);
  }
}
scoreTable(byId('score-table'), 'Round', scores.rounds.map((scores, index) => [String(index + 1), scores]));
scoreTable(byId('reference-table'), 'Browser', Object.entries(scores.references));

if (scores.categories) {
  const reviewer = byId('reviewer');
  for (const [index, entries] of scores.categories.entries()) {
    if (entries.length) addOption(reviewer, index, scores.models[index]);
  }
  function showReviewer() {
    const findings = byId('review-findings');
    findings.replaceChildren(...scores.categories[Number(reviewer.value)].flatMap(([category, score, reason]) => [
      node('dt', `${category} · ${score}`),
      node('dd', reason),
    ]));
  }
  if (reviewer.options.length) {
    byId('category-review').hidden = false;
    byId('category-review').querySelector('summary').textContent = `Round ${scores.categoryRound} category scores and deductions`;
    reviewer.addEventListener('change', showReviewer);
    showReviewer();
  }
}
