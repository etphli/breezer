const aliases = new Set(['latest', 'current', 'default', 'stable']);

function normalizeId(id) {
  return id.trim().toLowerCase().replace(/[_\s]+/g, '-').replace(/-+/g, '-');
}

function withoutAliasSuffix(value) {
  const parts = value.split('-');
  let removed = false;
  while (parts.length && aliases.has(parts.at(-1))) { parts.pop(); removed = true; }
  return { value: parts.join('-'), removed };
}

function numericVersion(value) {
  return value.split(/[.-]/).map(Number);
}

function modelFamily(id) {
  if (typeof id !== 'string' || !id.trim()) return null;
  const normalized = normalizeId(id);
  const { value, removed } = withoutAliasSuffix(normalized);
  const gpt = /^gpt-(\d+(?:[.-]\d+)*)(?:-(.*))?$/.exec(value);
  if (gpt) return {
    family: `gpt:${gpt[2] || 'base'}`,
    version: numericVersion(gpt[1]),
    revision: 0,
    alias: removed,
  };

  if (!value.startsWith('claude-')) return null;
  const version = [];
  let revision = 0;
  const family = [];
  for (const part of value.slice('claude-'.length).split('-')) {
    if (/^\d+(?:\.\d+)+$/.test(part)) {
      version.push(...numericVersion(part));
    } else if (/^\d+$/.test(part)) {
      if (part.length > 2) revision = Math.max(revision, Number(part));
      else version.push(Number(part));
    } else family.push(part);
  }
  if (!version.length && !revision) return null;
  return {
    family: `claude:${family.join('-') || 'base'}`,
    version: version.length ? version : [0],
    revision,
    alias: removed,
  };
}

function compareVersions(left, right) {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a !== b) return a > b ? 1 : -1;
  }
  return 0;
}

function compareModels(left, right) {
  return compareVersions(left.family.version, right.family.version)
    || Math.sign(left.family.revision - right.family.revision)
    || Number(left.model.isDefault === true) - Number(right.model.isDefault === true)
    || Number(right.family.alias) - Number(left.family.alias);
}

// Keep one newest reported release per recognized GPT/Claude family. Unknown IDs
// remain visible; exact IDs and explicit release aliases are deduplicated.
export function latestModels(models) {
  if (!Array.isArray(models)) return [];
  const seenIds = new Set();
  const winners = new Map();
  const retained = [];

  for (const [index, model] of models.entries()) {
    if (!model || typeof model.id !== 'string' || !model.id.trim() || seenIds.has(model.id)) continue;
    seenIds.add(model.id);
    const family = modelFamily(model.id);
    if (!family) { retained.push({ model, index }); continue; }
    const candidate = { model, family, index };
    const existing = winners.get(family.family);
    if (!existing || compareModels(candidate, existing) > 0) winners.set(family.family, candidate);
  }

  retained.push(...winners.values());
  return retained.sort((left, right) => left.index - right.index).map(({ model }) => model);
}
