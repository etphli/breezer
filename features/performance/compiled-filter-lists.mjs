const LIMITS = Object.freeze({ indexBytes: 64 * 1024, rawBytes: 8 * 1024 * 1024, payloadBytes: 16 * 1024 * 1024, entries: 64 });
const MISS = Object.freeze({ kind: 'miss' });
const digestPattern = /^[a-f0-9]{64}$/;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const positiveSize = (value, maximum) => Number.isSafeInteger(value) && value > 0 && value <= maximum;
const canonical = value => JSON.stringify(value, (_key, item) => record(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
const sha256 = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');

async function readOwnResource(path, maximum) {
  const response = await fetch(chrome.runtime.getURL(`assets/breezer-compiled/${path}`));
  if (!response.ok || Number(response.headers.get('content-length')) > maximum || !response.body) throw new Error('Unavailable compiled resource');
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) throw new Error('Compiled resource exceeds its limit');
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

// The caller supplies live compiler/trust context. Only the small index is kept;
// payload reads are serialized to bound transient buffers during parallel list loads.
export function createBundledFilterReader({ getContext, readResource = readOwnResource }) {
  const decoder = new TextDecoder('utf-8', { fatal: true }), encoder = new TextEncoder();
  let indexPromise, queue = Promise.resolve();
  const index = () => indexPromise ||= (async () => {
    const bytes = await readResource('index.json', LIMITS.indexBytes);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > LIMITS.indexBytes) return null;
    const value = JSON.parse(decoder.decode(bytes));
    return value?.schema === 1 && digestPattern.test(value.buildId) && record(value.context) && record(value.entries)
      && Object.keys(value.entries).length <= LIMITS.entries ? value : null;
  })().catch(() => null);

  const lookup = async ({ assetKey, rawText, trustedSource }) => {
    const catalog = await index();
    if (!catalog || !Object.hasOwn(catalog.entries, assetKey)) return MISS;
    const entry = catalog.entries[assetKey];
    if (!record(entry) || typeof entry.trustedSource !== 'boolean' || entry.trustedSource !== trustedSource
      || !digestPattern.test(entry.rawSha256) || !digestPattern.test(entry.payloadSha256)
      || entry.path !== `${entry.payloadSha256}.txt`
      || !positiveSize(entry.rawBytes, LIMITS.rawBytes) || !positiveSize(entry.payloadBytes, LIMITS.payloadBytes)
      || rawText.length > entry.rawBytes) return MISS;
    const expected = canonical({ ...catalog.context, buildId: catalog.buildId, trustedSource });
    if (canonical(await getContext(assetKey)) !== expected) return MISS;
    const raw = new Uint8Array(entry.rawBytes);
    const encoded = encoder.encodeInto(rawText, raw);
    if (encoded.read !== rawText.length || encoded.written !== raw.byteLength || await sha256(raw) !== entry.rawSha256) return MISS;
    const payload = await readResource(entry.path, entry.payloadBytes);
    if (!(payload instanceof Uint8Array) || payload.byteLength !== entry.payloadBytes || await sha256(payload) !== entry.payloadSha256) return MISS;
    const content = decoder.decode(payload);
    if (!content.startsWith(`${catalog.context.compiledMagic}\n`)) return MISS;
    // Context can change while hashing or fetching. A miss leaves the caller's
    // synchronous compiler to use the latest trust and capability settings.
    if (canonical(await getContext(assetKey)) !== expected) return MISS;
    return { kind: 'hit', content };
  };
  return {
    tryLoad(request) {
      if (!request || typeof request.assetKey !== 'string' || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(request.assetKey)
        || request.assetKey.startsWith('user-') || typeof request.rawText !== 'string'
        || request.rawText.length > LIMITS.rawBytes || !request.rawText.isWellFormed() || typeof request.trustedSource !== 'boolean') return Promise.resolve(MISS);
      const result = queue.then(() => lookup(request)).catch(() => MISS);
      queue = result.then(() => {});
      return result;
    },
  };
}
