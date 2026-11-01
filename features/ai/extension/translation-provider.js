export const TRANSLATION_KEY = 'translation.v1';
export const PROVIDERS = {
  local: { name: 'Local LibreTranslate', base: 'http://localhost:5000', origin: 'http://localhost/*' },
  hosted: { name: 'LibreTranslate.com', base: 'https://libretranslate.com', origin: 'https://libretranslate.com/*' },
};
const languageCode = value => typeof value === 'string' && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(value);

export function translationPreferences(value = {}) {
  return {
    provider: value.provider === 'hosted' ? 'hosted' : 'local',
    source: value.source === 'auto' || languageCode(value.source) ? value.source : 'auto',
    target: languageCode(value.target) ? value.target : 'en',
    dynamic: value.dynamic === true,
    apiKey: typeof value.apiKey === 'string' ? value.apiKey.slice(0, 512) : '',
  };
}

export async function providerRequest(prefs, path, { texts, source, target, signal, fetcher = fetch } = {}) {
  const provider = PROVIDERS[prefs.provider];
  if (!provider || !['languages', 'translate'].includes(path)) throw new Error('Unknown translation provider.');
  if (path === 'translate' && (!Array.isArray(texts) || !texts.length || texts.length > 32 || texts.some(t => typeof t !== 'string' || !t.trim()) || texts.reduce((n, t) => n + t.length, 0) > 4000 || !(source === 'auto' || languageCode(source)) || !languageCode(target) || source === target)) throw new Error('Invalid translation request.');
  if (path === 'translate' && prefs.provider === 'hosted' && !prefs.apiKey) throw new Error('Add your LibreTranslate.com API key in Translation settings.');
  const timeout = AbortSignal.timeout(25000);
  let response;
  try {
    response = await fetcher(`${provider.base}/${path}`, {
      method: path === 'translate' ? 'POST' : 'GET',
      credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      ...(path === 'translate' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ q: texts, source, target, format: 'text', ...(prefs.apiKey ? { api_key: prefs.apiKey } : {}) }) } : {}),
    });
  } catch {
    if (signal?.aborted) throw new Error('Translation cancelled.');
    if (timeout.aborted) throw new Error('Translation provider took too long. Wait for its models to load, then retry.');
    throw new Error(prefs.provider === 'local' ? 'Cannot reach local LibreTranslate at localhost:5000. Start your server, then retry.' : 'LibreTranslate.com could not be reached. Check your connection, then retry.');
  }
  if (!response.ok) {
    const message = { 400: 'The provider rejected this language pair or API key.', 401: 'The provider requires a valid API key.', 403: 'The provider refused this API key.', 429: 'Translation rate limit reached. Wait before retrying.' }[response.status];
    throw new Error(message || `Translation provider failed (HTTP ${response.status}). Retry later.`);
  }
  // Bound responses before parsing; never display provider error bodies or credentials.
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Translation provider returned an empty response.');
  const decoder = new TextDecoder(); let body = '', bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 250000) { await reader.cancel(); throw new Error('Translation provider returned too much data.'); }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
  } catch (error) {
    if (signal?.aborted) throw new Error('Translation cancelled.');
    if (bytes > 250000) throw error;
    throw new Error('Translation provider response was interrupted. Retry translation.');
  }
  let data;
  try { data = JSON.parse(body); } catch { throw new Error('Translation provider returned invalid JSON.'); }
  if (path === 'languages') {
    if (!Array.isArray(data) || !data.length || data.length > 200 || data.some(l => !languageCode(l.code) || typeof l.name !== 'string' || l.name.length > 100 || !Array.isArray(l.targets) || l.targets.some(t => !languageCode(t)))) throw new Error('Translation provider returned an invalid language list.');
    return data.map(({ code, name, targets }) => ({ code, name, targets }));
  }
  if (!Array.isArray(data.translatedText) || data.translatedText.length !== texts.length || data.translatedText.some(t => typeof t !== 'string' || t.length > 40000)) throw new Error('Translation provider returned an invalid text batch.');
  return data.translatedText;
}
