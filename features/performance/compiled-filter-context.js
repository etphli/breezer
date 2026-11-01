import { createBundledFilterReader } from './breezer-compiled-filter-lists.js';
import { buildId, engineVersion, engineJavaScriptVersion } from './breezer-compiled-filter-build.js';
import { getTrustedTokens } from './trusted-tokens.js';
import io from './assets.js';
import staticNetFilteringEngine from './static-net-filtering.js';
import µb from './background.js';

const reader = createBundledFilterReader({
    async getContext(assetKey) {
        const tokens = JSON.stringify([...getTrustedTokens()].sort());
        const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(tokens));
        return {
            buildId,
            engineVersion,
            engineJavaScriptVersion,
            compiledMagic: µb.systemSettings.compiledMagic,
            environment: [...vAPI.webextFlavor.env].sort(),
            maxTokenLength: staticNetFilteringEngine.MAX_TOKEN_LENGTH,
            canFilterResponseBody: µb.canFilterResponseData,
            trustedTokensSha256: [...new Uint8Array(bytes)].map(v => v.toString(16).padStart(2, '0')).join(''),
            trustedSource: µb.isTrustedList(assetKey),
        };
    },
});

const pending = new Map();
io.addObserver((topic, details) => {
    if (topic !== 'after-asset-updated') return;
    for (const request of pending.get(details.assetKey) || []) request.changed = true;
});

export const bundledFilterLists = {
    async read(request, consume) {
        const state = { changed: false };
        let requests = pending.get(request.assetKey);
        if (!requests) pending.set(request.assetKey, requests = new Set());
        requests.add(state);
        try {
            const result = await reader.tryLoad(request);
            // Keep the freshness check and the caller's cache submission in one
            // synchronous turn; resolving first would introduce another race.
            return consume(state.changed ? { kind: 'retry' } : result);
        } finally {
            requests.delete(state);
            if (requests.size === 0) pending.delete(request.assetKey);
        }
    },
};
