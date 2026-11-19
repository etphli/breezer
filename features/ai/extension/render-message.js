// Provider output is untrusted. Build nodes directly; never interpret output as HTML.
export function renderMessage(container, text) {
  container.replaceChildren();
  const lines = text.split('\n');
  let paragraph = [];
  let list = null;
  function flush() {
    if (paragraph.length) {
      const p = document.createElement('p');
      inline(p, paragraph.join('\n'));
      container.append(p);
      paragraph = [];
    }
    list = null;
  }
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    let columns;
    if (/^\s*```/.test(line)) {
      flush();
      const code = document.createElement('code');
      const pre = document.createElement('pre');
      const body = [];
      while (++index < lines.length && !/^\s*```/.test(lines[index])) body.push(lines[index]);
      code.textContent = body.join('\n');
      pre.append(code);
      container.append(pre);
    } else if (/^#{1,4}\s/.test(line)) {
      flush();
      const heading = document.createElement('h3');
      inline(heading, line.replace(/^#{1,4}\s+/, ''));
      container.append(heading);
    } else if (/^\s*(?:[-*]|\d+\.)\s/.test(line)) {
      if (paragraph.length) flush();
      const tag = /^\s*\d+\./.test(line) ? 'ol' : 'ul';
      if (!list || list.localName !== tag) {
        list = document.createElement(tag);
        container.append(list);
      }
      const item = document.createElement('li');
      inline(item, line.replace(/^\s*(?:[-*]|\d+\.)\s+/, ''));
      list.append(item);
    } else if (/^>\s?/.test(line)) {
      flush();
      const quote = document.createElement('blockquote');
      inline(quote, line.replace(/^>\s?/, ''));
      container.append(quote);
    } else if (!line.trim()) {
      flush();
    } else if (!paragraph.length && (columns = tableColumns(line, lines[index + 1]))) {
      flush();
      index = appendTable(container, lines, index, columns);
    } else {
      list = null;
      paragraph.push(line);
    }
  }
  flush();
}

function tableCells(line) {
  const text = line.trim();
  const cells = [];
  let start = 0;
  for (const match of text.matchAll(/\\[\\|]|\|/g)) {
    if (match[0] !== '|') continue;
    if (match.index) cells.push(text.slice(start, match.index).trim());
    start = match.index + 1;
  }
  if (!start) return [];
  if (start < text.length) cells.push(text.slice(start).trim());
  return cells.map(cell => cell.replace(/\\\|/g, '|'));
}

function tableColumns(header, separator) {
  if (!separator?.includes('|')) return null;
  const markers = tableCells(separator);
  if (!markers.length || !markers.every(marker => /^:?-+:?$/.test(marker))) return null;
  const labels = tableCells(header);
  if (labels.length !== markers.length) return null;
  return labels.map((label, index) => {
    const marker = markers[index];
    const align = marker.endsWith(':') ? (marker.startsWith(':') ? 'center' : 'right') : 'left';
    return { label, align };
  });
}

function appendTable(container, lines, index, columns) {
  const wrapper = document.createElement('div');
  wrapper.className = 'message-table';
  const table = document.createElement('table');
  const head = document.createElement('thead');
  const headings = document.createElement('tr');
  for (const { label, align } of columns) {
    const cell = document.createElement('th');
    cell.scope = 'col';
    cell.className = align;
    inline(cell, label);
    headings.append(cell);
  }
  head.append(headings);
  const body = document.createElement('tbody');
  index += 2;
  while (index < lines.length) {
    const line = lines[index];
    if (/^\s*```|^#{1,4}\s|^\s*(?:[-*]|\d+\.)\s|^>/.test(line)) break;
    const values = tableCells(line);
    if (!values.length) break;
    const row = document.createElement('tr');
    columns.forEach(({ align }, column) => {
      const cell = document.createElement('td');
      cell.className = align;
      inline(cell, values[column] ?? '');
      row.append(cell);
    });
    body.append(row);
    index++;
  }
  table.append(head, body);
  wrapper.append(table);
  container.append(wrapper);
  return index - 1;
}

function inline(parent, text) {
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/g;
  let start = 0;
  for (const match of text.matchAll(pattern)) {
    parent.append(document.createTextNode(text.slice(start, match.index)));
    const token = match[0];
    if (token.startsWith('`')) {
      const code = document.createElement('code');
      code.textContent = token.slice(1, -1);
      parent.append(code);
    } else if (token.startsWith('**')) {
      const strong = document.createElement('strong');
      strong.textContent = token.slice(2, -2);
      parent.append(strong);
    } else {
      const split = token.indexOf('](');
      const link = document.createElement('a');
      link.textContent = token.slice(1, split);
      link.href = token.slice(split + 2, -1);
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      parent.append(link);
    }
    start = match.index + token.length;
  }
  parent.append(document.createTextNode(text.slice(start)));
}

// Append-only streaming input. A complete blank line outside a fence ends all
// parser context, so earlier nodes can stay attached while the tail is rebuilt.
export function createMessageStream(container) {
  let tail = '';
  let lineStart = 0;
  let fenced = false;
  let started = false;
  let mutableNodes = [];
  let plainText = null;
  let codeText = null;
  let plainAllowed = true;
  const target = {
    replaceChildren() {
      plainText = null;
      codeText = null;
      for (const node of mutableNodes) node.remove();
      mutableNodes = [];
    },
    append(node) {
      container.append(node);
      mutableNodes.push(node);
    },
  };
  return {
    append(delta) {
      if (!container) return;
      if (!started) { container.replaceChildren(); started = true; }
      let searchFrom = tail.length;
      tail += delta;
      let boundary = 0;
      let end;
      while ((end = tail.indexOf('\n', searchFrom)) !== -1) {
        const line = tail.slice(lineStart, end);
        if (/^\s*```/.test(line)) fenced = !fenced;
        else if (!fenced && !line.trim()) boundary = end + 1;
        lineStart = end + 1;
        searchFrom = lineStart;
      }
      if (boundary) {
        renderMessage(target, tail.slice(0, boundary));
        mutableNodes = [];
        tail = tail.slice(boundary);
        lineStart -= boundary;
        plainText = null;
        plainAllowed = true;
      }
      // The opener is complete and the current code line has no backticks.
      // A possible closing fence must rebuild, including its preceding newline.
      if (codeText && !delta.includes('`')) {
        codeText.appendData(delta);
        return;
      }
      // Once ambiguous, use the unchanged parser until the next stable boundary.
      if (plainAllowed && tail) {
        const safe = plainText
          ? !/[\n`*\[]/.test(delta)
          : /^[^\s#>0-9\-`*\[]/.test(tail) && !/[\n`*\[]/.test(tail);
        if (safe) {
          if (plainText) plainText.appendData(delta);
          else {
            renderMessage(target, tail);
            plainText = mutableNodes[0].lastChild;
          }
          return;
        }
        plainAllowed = false;
        plainText = null;
      }
      renderMessage(target, tail);
      if (fenced && !tail.includes('`', lineStart)) {
        codeText = mutableNodes.at(-1).lastChild.lastChild;
      }
    },
    dispose() {
      container = null;
      plainText = null;
      codeText = null;
      plainAllowed = false;
      tail = '';
      mutableNodes = [];
      lineStart = 0;
      fenced = false;
    },
  };
}
