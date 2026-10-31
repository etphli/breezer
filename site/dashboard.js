const $ = id => document.getElementById(id);
const numbers = new Intl.NumberFormat('en', { maximumFractionDigits: 0 });
const hours = seconds => (seconds / 3600).toLocaleString('en', { maximumFractionDigits: 1 });
const dayLabel = day => new Date(`${day}T00:00:00Z`).toLocaleDateString('en', { month: 'short', day: 'numeric', timeZone: 'UTC' });

function renderChart(series) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 900 210');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('aria-hidden', 'true');
  const max = Math.max(3600, ...series.map(row => row.seconds));
  series.forEach((row, index) => {
    const rect = document.createElementNS(ns, 'rect');
    const height = row.seconds / max * 195;
    for (const [key, value] of Object.entries({ x: index * 30 + 5, y: 210 - height, width: 20, height, rx: 3, class: 'bar' })) rect.setAttribute(key, value);
    const title = document.createElementNS(ns, 'title');
    title.textContent = `${dayLabel(row.day)}: ${hours(row.seconds)} hours, ${numbers.format(row.users)} active profiles`;
    rect.append(title); svg.append(rect);
  });
  $('chart').replaceChildren(svg);
  $('chart').setAttribute('aria-label', 'Daily active hours over 30 days. Exact values are in View daily measurements below.');
}

function rows(target, values) {
  $(target).replaceChildren(...values.map(values => {
    const tr = document.createElement('tr');
    for (const value of values) { const td = document.createElement('td'); td.textContent = value; tr.append(td); }
    return tr;
  }));
}

async function load() {
  $('refresh').disabled = true;
  $('error').hidden = true;
  $('metrics').setAttribute('aria-busy', 'true');
  try {
    const response = await fetch('/api/metrics', { cache: 'no-store', signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error('Metrics could not be loaded. Try refreshing shortly.');
    const data = await response.json();
    $('downloads').textContent = numbers.format(data.downloads);
    $('mau').textContent = numbers.format(data.mau);
    $('hours').textContent = hours(data.seconds);
    $('month').textContent = new Date(`${data.month}-01T00:00:00Z`).toLocaleDateString('en', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    $('updated').textContent = `Updated ${new Date(data.updatedAt).toLocaleString('en', { timeZone: 'UTC' })} UTC`;
    $('range').textContent = `${dayLabel(data.start)} to ${dayLabel(data.end)} · Daily active hours`;
    $('chart-start').textContent = dayLabel(data.start); $('chart-end').textContent = dayLabel(data.end);
    $('empty').hidden = data.series.some(row => row.users > 0);
    rows('daily', [...data.series].reverse().map(row => [dayLabel(row.day), numbers.format(row.users), hours(row.seconds)]));
    rows('releases', data.releases.map(row => [row.version, numbers.format(row.downloads)]));
    renderChart(data.series);
  } catch (error) { $('error').textContent = error.message; $('error').hidden = false; $('updated').textContent = 'Unable to refresh. Any displayed figures are from the last successful load.'; }
  finally { $('refresh').disabled = false; $('metrics').setAttribute('aria-busy', 'false'); }
}
$('refresh').addEventListener('click', load);
void load();
