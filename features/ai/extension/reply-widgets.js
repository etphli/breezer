// Replies supply data. Breezer owns the elements, styles, and allowed map URL.
const svgNamespace = 'http://www.w3.org/2000/svg';
const text = (value, limit) => typeof value === 'string' && value.trim() && value.length <= limit;
const range = (value, min, max) => Number.isFinite(value) && value >= min && value <= max;
const list = (value, min, max) => Array.isArray(value) && value.length >= min && value.length <= max;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function element(tag, value, className) {
  const node = document.createElement(tag);
  if (value !== undefined) node.textContent = value;
  if (className) node.className = className;
  return node;
}

function svg(tag, attributes) {
  const node = document.createElementNS(svgNamespace, tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  return node;
}

function disclosure(label, content) {
  const details = element('details');
  details.append(element('summary', label), content);
  return details;
}

function diagramRows(nodes, edges) {
  const remaining = new Set(nodes.map(node => node.id));
  const parents = new Map(nodes.map(node => [node.id, []]));
  for (const edge of edges) parents.get(edge.to).push(edge.from);
  const rows = [];
  while (remaining.size) {
    const ready = [...remaining].filter(id => parents.get(id).every(parent => !remaining.has(parent)));
    // Give a cycle a starting row. The return edge still appears in the diagram.
    if (!ready.length) ready.push(remaining.values().next().value);
    for (let index = 0; index < ready.length; index += 2) rows.push(ready.slice(index, index + 2));
    for (const id of ready) remaining.delete(id);
  }
  return rows;
}

function displayLines(label) {
  const lines = label.trim().replace(/\s+/g, ' ').match(/.{1,16}(?:\s|$)|.{1,16}/gu);
  return lines.length > 3 ? [...lines.slice(0, 2), lines[2].trim().slice(0, 15) + '…'] : lines;
}

let diagramId = 0;

function diagram(card, data) {
  const { nodes, edges } = data;
  if (!list(nodes, 2, 12) || !list(edges, 1, 18) || !nodes.every(node => record(node)
      && typeof node.id === 'string' && /^[a-zA-Z0-9_-]{1,24}$/.test(node.id)
      && text(node.label, 80) && (node.detail === undefined || text(node.detail, 500)))) return false;
  const byId = new Map(nodes.map(node => [node.id, node]));
  if (byId.size !== nodes.length || !edges.every(edge => record(edge)
      && edge.from !== edge.to && byId.has(edge.from) && byId.has(edge.to)
      && (edge.label === undefined || text(edge.label, 72)))) return false;

  const rows = diagramRows(nodes, edges);
  const positions = new Map(rows.flatMap((row, index) => row.map((id, column) => [id, {
    x: row.length === 1 ? 144 : 80 + column * 128,
    y: 32 + index * 88,
  }])));
  const drawing = svg('svg', { viewBox: '0 0 288 ' + (rows.length * 88 - 24), 'aria-hidden': 'true', class: 'reply-flow' });
  const defs = svg('defs', {});
  const marker = 'breezer-arrow-' + ++diagramId;
  const arrow = svg('marker', { id: marker, viewBox: '0 0 8 8', refX: 7, refY: 4, markerWidth: 7, markerHeight: 7, orient: 'auto' });
  arrow.append(svg('path', { d: 'M0 0 8 4 0 8Z', class: 'reply-flow-arrow' }));
  defs.append(arrow);
  drawing.append(defs);

  for (const edge of edges) {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    let path;
    if (to.y - from.y === 88) {
      const mid = (from.y + to.y) / 2;
      path = ['M', from.x, from.y + 27, 'V', mid, 'H', to.x, 'V', to.y - 29].join(' ');
    } else if (to.y === from.y) {
      const side = Math.sign(to.x - from.x);
      path = ['M', from.x + side * 57, from.y, 'H', to.x - side * 59].join(' ');
    } else {
      const direction = from.x + to.x <= 288 ? -1 : 1;
      const gutter = direction < 0 ? 8 : 280;
      path = ['M', from.x + direction * 57, from.y, 'H', gutter, 'V', to.y, 'H', to.x + direction * 59].join(' ');
    }
    drawing.append(svg('path', { d: path, class: 'reply-flow-edge', 'marker-end': 'url(#' + marker + ')' }));
  }

  for (const node of nodes) {
    const { x, y } = positions.get(node.id);
    drawing.append(svg('rect', { x: x - 57, y: y - 27, width: 114, height: 54, rx: 10, class: 'reply-flow-node' }));
    const label = svg('text', { x, 'text-anchor': 'middle', class: 'reply-flow-label' });
    const lines = displayLines(node.label);
    lines.forEach((line, index) => {
      const span = svg('tspan', { x, y: y + 4 + (index - (lines.length - 1) / 2) * 14 });
      span.textContent = line.trim();
      label.append(span);
    });
    drawing.append(label);
  }

  const links = element('ul');
  for (const { from, to, label } of edges) {
    links.append(element('li', byId.get(from).label + ' → ' + byId.get(to).label + (label ? ' (' + label + ')' : '')));
  }
  const description = element('div');
  description.append(links);
  for (const node of nodes) {
    if (node.detail) description.append(disclosure(node.label, element('p', node.detail)));
  }
  card.append(drawing, disclosure('Flow and step details', description));
  return true;
}

function chart(card, data) {
  if (!list(data.items, 1, 10) || !data.items.every(item => record(item) && text(item.label, 60)
      && range(item.value, -1e12, 1e12)) || (data.unit !== undefined && !text(data.unit, 16))) return false;
  const max = Math.max(...data.items.map(item => Math.abs(item.value))) || 1;
  const signed = data.items.some(item => item.value < 0);
  const rows = element('ul', undefined, 'reply-chart');
  for (const item of data.items) {
    const row = element('li');
    const name = element('span', item.label);
    const value = element('b', new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 }).format(item.value) + (data.unit ? ' ' + data.unit : ''));
    const rail = element('span', undefined, 'reply-chart-rail');
    rail.setAttribute('aria-hidden', 'true');
    const fill = element('span', undefined, 'reply-chart-bar');
    const width = Math.abs(item.value) / max * (signed ? 50 : 100);
    fill.style.width = width + '%';
    fill.style.left = (signed ? 50 - (item.value < 0 ? width : 0) : 0) + '%';
    rail.append(fill);
    row.append(name, value, rail);
    rows.append(row);
  }
  card.append(rows);
  return true;
}

function map(card, data) {
  const { lat, lon, zoom = 13 } = data;
  if (!range(lat, -85, 85) || !range(lon, -180, 180) || !Number.isInteger(zoom) || !range(zoom, 3, 18)) return false;
  const distance = 120 / 2 ** zoom;
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const bounds = [clamp(lon - distance, -180, 180), clamp(lat - distance, -85.051, 85.051),
    clamp(lon + distance, -180, 180), clamp(lat + distance, -85.051, 85.051)];
  const url = new URL('https://www.openstreetmap.org/export/embed.html');
  url.search = new URLSearchParams({ bbox: bounds.join(','), layer: 'mapnik', marker: [lat, lon].join(',') });
  const load = element('button', 'Load interactive map', 'reply-widget-button');
  load.type = 'button';
  const link = element('a', 'Open in OpenStreetMap');
  link.href = 'https://www.openstreetmap.org/?mlat=' + lat + '&mlon=' + lon + '#map=' + zoom + '/' + lat + '/' + lon;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  const actions = element('div', undefined, 'reply-map-actions');
  actions.append(load, link);
  const mapSlot = element('div');
  load.addEventListener('click', () => {
    if (mapSlot.firstChild) {
      mapSlot.replaceChildren();
      load.textContent = 'Load interactive map';
      return;
    }
    const frame = element('iframe');
    frame.title = data.title + ' · OpenStreetMap';
    frame.referrerPolicy = 'no-referrer';
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    frame.src = url.href;
    mapSlot.append(frame);
    load.textContent = 'Hide map';
  });
  card.append(element('p', 'Map tiles load from OpenStreetMap when you open the map.'), actions, mapSlot);
  return true;
}

function cards(card, data) {
  if (!list(data.items, 1, 8) || !data.items.every(item => record(item)
      && text(item.label, 80) && text(item.detail, 800))) return false;
  for (const item of data.items) card.append(disclosure(item.label, element('p', item.detail)));
  return true;
}

const renderers = new Map([['flow', diagram], ['chart', chart], ['map', map], ['cards', cards]]);

export function renderReplyWidget(source) {
  if (source.length > 12_000) return null;
  let data;
  try { data = JSON.parse(source); } catch { return null; }
  if (!record(data) || !text(data.title, 100) || typeof data.type !== 'string' || !renderers.has(data.type)) return null;
  const card = element('figure', undefined, 'reply-widget');
  card.append(element('figcaption', data.title));
  return renderers.get(data.type)(card, data) ? card : null;
}

export function validGeneratedImage(value) {
  return typeof value === 'string' && value.length <= 820_023
    && /^data:image\/webp;base64,[A-Za-z0-9+/]+={0,2}$/.test(value);
}

export function appendGeneratedImage(container, image) {
  if (!validGeneratedImage(image)) return;
  const card = element('figure', undefined, 'reply-widget reply-image');
  const art = element('img');
  art.src = image;
  art.alt = 'Generated image';
  art.loading = 'lazy';
  art.width = 1024;
  art.height = 1024;
  const download = element('a', 'Save image');
  download.href = image;
  download.download = 'breezer-image.webp';
  const caption = element('figcaption');
  caption.append(download);
  card.append(art, caption);
  container.append(card);
}
