// Replies supply data. Breezer owns the elements, styles, and allowed requests.
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

const decimal = value => String(Number(value.toFixed(6)));

// OpenStreetMap snaps its embed to the closest zoom where these bounds fit.
// A 200px Web Mercator square selects the requested zoom in the 240px frame at
// every latitude. Longitudes may pass 180 so an antimeridian marker stays centered.
export function mapURL({ lat, lon, zoom }) {
  const half = 100 * 360 / (256 * 2 ** zoom);
  const radians = half * Math.PI / 180;
  const center = Math.asinh(Math.tan(lat * Math.PI / 180));
  const latitude = y => Math.max(-85.0511, Math.min(85.0511, Math.atan(Math.sinh(y)) * 180 / Math.PI));
  const bounds = [lon - half, latitude(center - radians), lon + half, latitude(center + radians)];
  const url = new URL('https://www.openstreetmap.org/export/embed.html');
  url.search = new URLSearchParams({ bbox: bounds.map(decimal).join(','), layer: 'mapnik', marker: decimal(lat) + ',' + decimal(lon) });
  return url.href;
}

function webLink(label, href) {
  const link = element('a', label);
  link.href = href;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  return link;
}

function widgetButton(label) {
  const button = element('button', label, 'reply-widget-button');
  button.type = 'button';
  return button;
}

function statusLine() {
  const status = element('p', '', 'reply-widget-status');
  status.setAttribute('role', 'status');
  return status;
}

function map(card, data) {
  const { lat, lon, place } = data;
  if (place !== undefined && !text(place, 200)) return false;
  const placeLink = place && webLink('Find this place', 'https://www.openstreetmap.org/search?' + new URLSearchParams({ query: place.trim() }));
  const actions = element('div', undefined, 'reply-widget-actions');
  if (lat === undefined && lon === undefined && placeLink) {
    actions.append(placeLink);
    card.append(element('p', 'No coordinates were provided. Find the place in OpenStreetMap.'), actions);
    return true;
  }
  if (!range(lat, -85, 85) || !range(lon, -180, 180) || (data.zoom !== undefined && !Number.isFinite(data.zoom))) return false;
  const zoom = Math.min(19, Math.max(3, Math.round(data.zoom ?? 13)));
  const load = widgetButton('Load interactive map');
  const point = decimal(lat) + '/' + decimal(lon);
  actions.append(load, webLink('Open in OpenStreetMap', 'https://www.openstreetmap.org/?mlat=' + decimal(lat) + '&mlon=' + decimal(lon) + '#map=' + zoom + '/' + point));
  if (placeLink) actions.append(placeLink);
  const mapSlot = element('div');
  const status = statusLine();
  let slow;
  load.addEventListener('click', () => {
    clearTimeout(slow);
    status.textContent = '';
    if (mapSlot.firstChild) {
      mapSlot.replaceChildren();
      load.textContent = 'Load interactive map';
      return;
    }
    const frame = element('iframe');
    frame.title = data.title + ' · OpenStreetMap';
    frame.referrerPolicy = 'no-referrer';
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    frame.addEventListener('load', () => {
      if (!frame.isConnected) return;
      clearTimeout(slow);
      status.textContent = '';
    });
    frame.src = mapURL({ lat, lon, zoom });
    status.textContent = 'Loading map…';
    slow = setTimeout(() => { status.textContent = 'The map is taking a while. Hide it and try again, or open it in OpenStreetMap.'; }, 12_000);
    mapSlot.append(frame);
    load.textContent = 'Hide map';
  });
  card.append(element('p', 'Marker at ' + decimal(lat) + ', ' + decimal(lon) + ', supplied by the assistant. The map loads from OpenStreetMap when you open it.'), actions, status, mapSlot);
  return true;
}

function ordinaryURL(value, protocols) {
  if (!text(value, 2048)) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  return protocols.includes(url.protocol) && !url.username && !url.password ? url : null;
}

// Images load only after a click, and only from a named public HTTPS host.
function imageURL(value) {
  const url = ordinaryURL(value, ['https:']);
  if (!url || url.port || /^\[|^\d+(?:\.\d+){3}\.?$/.test(url.hostname) || !url.hostname.includes('.')
      || /(?:^|\.)(?:local|localhost|internal|lan|home|arpa|test|invalid|onion)\.?$/.test(url.hostname)) return null;
  return url;
}

function existingImage(card, data) {
  const source = data.source === undefined ? null : ordinaryURL(data.source, ['http:', 'https:']);
  const url = data.url === undefined ? null : imageURL(data.url);
  if ((data.source !== undefined && !source) || (data.url !== undefined && !url) || (!url && !source)
      || (data.alt !== undefined && !text(data.alt, 300))) return false;
  const actions = element('div', undefined, 'reply-widget-actions');
  const note = element('p', url ? 'Web image from ' + url.hostname + '. It loads when you view it.' : 'Web image on ' + source.hostname + '. Open the source to view it.');
  if (!url) {
    actions.append(webLink('Open source', source.href));
    card.append(note, actions);
    return true;
  }
  const view = widgetButton('View image');
  actions.append(view, webLink('Open image', url.href));
  if (source) actions.append(webLink('Open source', source.href));
  const status = statusLine();
  const slot = element('div', undefined, 'reply-web-image');
  view.addEventListener('click', () => {
    status.textContent = '';
    if (slot.firstChild) {
      slot.replaceChildren();
      view.textContent = 'View image';
      return;
    }
    const art = element('img');
    art.alt = data.alt || data.title;
    art.referrerPolicy = 'no-referrer';
    art.decoding = 'async';
    art.addEventListener('load', () => { if (art.isConnected) status.textContent = ''; });
    art.addEventListener('error', () => {
      if (!art.isConnected) return;
      slot.replaceChildren();
      view.textContent = 'View image';
      status.textContent = 'This image could not load. Open its link to check it.';
    });
    status.textContent = 'Loading image…';
    slot.append(art);
    view.textContent = 'Hide image';
    art.src = url.href;
  });
  card.append(note, actions, status, slot);
  return true;
}

// A reply can suggest a query. Only the user's click runs it, in the user's
// default search engine, through the browser's search API.
function webSearch(card, data) {
  if (!text(data.query, 200) || /[\u0000-\u001f\u007f]/.test(data.query)) return false;
  const query = data.query.trim();
  const run = widgetButton('Search the web');
  const status = statusLine();
  run.addEventListener('click', async () => {
    try {
      await globalThis.chrome.search.query({ text: query, disposition: 'NEW_TAB' });
      status.textContent = 'Results opened in a new tab. Open the pages you want to use, then choose them with Sources in the sidebar and ask again.';
    } catch { status.textContent = 'The search could not open. Enter the query in the address bar.'; }
  });
  const actions = element('div', undefined, 'reply-widget-actions');
  actions.append(run);
  card.append(element('p', query, 'reply-search-query'), actions, status);
  return true;
}

function cards(card, data) {
  if (!list(data.items, 1, 8) || !data.items.every(item => record(item)
      && text(item.label, 80) && text(item.detail, 800))) return false;
  for (const item of data.items) card.append(disclosure(item.label, element('p', item.detail)));
  return true;
}

const renderers = new Map([['flow', diagram], ['chart', chart], ['map', map], ['cards', cards],
  ['image', existingImage], ['search', webSearch]]);

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
