// Implements Helium's existing provider API. Every data buffer is opaque native
// vault ciphertext. This provider has no key wrapping or credential permission.
const ROOT = 'http://127.0.0.1:18765';
const HTTP_ERRORS = new Map([[401, 'AUTH_REQUIRED'], [403, 'ACCESS_DENIED'], [404, 'NOT_FOUND'], [409, 'CONFLICT'], [412, 'CONFLICT'], [413, 'QUOTA_EXCEEDED'], [429, 'QUOTA_EXCEEDED'], [503, 'TEMPORARY_ERROR']]);
export function installTestProvider({ api, fetchImpl = globalThis.fetch }) {
  const pending = new Map();
  const listeners = [];
  const reply = (response) => api.syncVaultProvider.respond(response).catch(() => {});
  const wire = (event, run) => {
    const handler = (request) => {
      const controller = new AbortController();
      pending.set(request.requestId, controller);
      const timer = setTimeout(() => controller.abort(), 90000);
      void (async () => {
        const saved = await api.storage.local.get('testProviderToken');
        if (typeof saved.testProviderToken !== 'string' || !saved.testProviderToken) throw { providerError: 'AUTH_REQUIRED' };
        const http = async (path, options = {}) => {
          const response = await fetchImpl(`${ROOT}${path}`, {
            ...options, signal: controller.signal,
            credentials: 'omit', redirect: 'error', cache: 'no-store',
            headers: { ...options.headers, Authorization: `Bearer ${saved.testProviderToken}` },
          });
          if (!response.ok) throw { providerError: HTTP_ERRORS.get(response.status) || 'INVALID_DATA' };
          return response;
        };
        const success = await run(request, http);
        if (pending.get(request.requestId) === controller) await reply({ requestId: request.requestId, success });
      })().catch(async (error) => {
        if (pending.get(request.requestId) === controller) await reply({ requestId: request.requestId, failure: { error: error.providerError || 'NETWORK_ERROR' } });
      }).finally(() => {
        clearTimeout(timer);
        if (pending.get(request.requestId) === controller) pending.delete(request.requestId);
      });
    };
    event.addListener(handler);
    listeners.push([event, handler]);
  };
  const vaultPath = (request) => `/v1/vaults/${encodeURIComponent(request.vaultUuid)}`;
  const objectPath = (request) => `${vaultPath(request)}/objects/${encodeURIComponent(request.objectId)}`;
  wire(api.syncVaultProvider.onConfigureRequested, async (_request, http) => {
    const result = await (await http('/health')).json();
    if (result.version !== 1) throw { providerError: 'UNSUPPORTED' };
    return { configurationState: 'READY' };
  });
  wire(api.syncVaultProvider.onListVaultsRequested, async (_request, http) => ({ vaults: await (await http('/v1/vaults')).json() }));
  wire(api.syncVaultProvider.onCreateVaultRequested, async (request, http) => {
    await http(vaultPath(request), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ displayName: request.displayName }) });
    return {};
  });
  wire(api.syncVaultProvider.onReadObjectRequested, async (request, http) => {
    const response = await http(objectPath(request));
    const size = response.headers.get('Content-Length');
    if (!size || !/^\d+$/.test(size) || Number(size) > request.maxBytes) throw { providerError: 'INVALID_DATA' };
    const data = await response.arrayBuffer();
    if (data.byteLength > request.maxBytes) throw { providerError: 'INVALID_DATA' };
    const revision = response.headers.get('ETag');
    if (!revision) throw { providerError: 'INVALID_DATA' };
    return { data, revision };
  });
  wire(api.syncVaultProvider.onWriteObjectRequested, async (request, http) => {
    const headers = request.expectedRevision === undefined ? { 'If-None-Match': '*' } : { 'If-Match': request.expectedRevision };
    if (request.retentionEpoch !== undefined) headers['X-Retention-Epoch'] = String(request.retentionEpoch);
    const response = await http(objectPath(request), { method: 'PUT', headers, body: request.data });
    const revision = response.headers.get('ETag');
    if (!revision) throw { providerError: 'INVALID_DATA' };
    return { revision };
  });
  wire(api.syncVaultProvider.onRenameVaultRequested, async () => { throw { providerError: 'UNSUPPORTED' }; });
  wire(api.syncVaultProvider.onCollectEpochsRequested, async () => { throw { providerError: 'UNSUPPORTED' }; });
  const cancel = ({ requestId }) => {
    const controller = pending.get(requestId);
    pending.delete(requestId);
    controller?.abort();
  };
  api.syncVaultProvider.onCancelRequested.addListener(cancel);
  return {
    dispose() {
      for (const [event, handler] of listeners) event.removeListener(handler);
      api.syncVaultProvider.onCancelRequested.removeListener(cancel);
      for (const controller of pending.values()) controller.abort();
      pending.clear();
    },
  };
}
