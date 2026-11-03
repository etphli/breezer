import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import vm from 'node:vm';

const fixtures = [
  ['workspace-browser.test.mjs', 9], ['newtab-browser.test.mjs', 3],
  ['onboarding-browser.test.mjs', 1], ['whats-new-browser.test.mjs', 1], ['workspace-frame.test.mjs', 1],
];
for (const [file, expected] of fixtures) for (const phase of ['launch', 'browser close']) {
  test(`${file} closes its server after ${phase} failure`, async () => {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    const callbacks = [];
    let server;
    const failure = new Error(`Synthetic ${phase} failure`);
    const browser = {
      newPage: async () => { throw new Error('Stop before browser work'); },
      newContext: async () => { throw new Error('Stop before browser work'); },
      close: async () => { throw failure; },
    };
    const context = vm.createContext({
      test: (_name, _options, callback) => callbacks.push(callback), skip: false,
      chromium: { launch: async () => { if (phase === 'launch') throw failure; return browser; } },
      executablePath: undefined, evidence: '', videoDir: '', mkdir: async () => {}, seed: () => ({}),
      SITES: [], CONNECTED: { organato: {} },
      startServer: async () => {
        server = createServer();
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        return server;
      },
    });
    vm.runInContext(source.slice(source.indexOf("test('")), context);
    assert.equal(callbacks.length, expected);
    for (const callback of callbacks) {
      try {
        await assert.rejects(callback(), error => error === failure);
        assert.equal(server.listening, false, 'the owned fixture server must close');
      } finally {
        if (server?.listening) await new Promise(resolve => server.close(resolve));
      }
    }
  });
}

for (const file of ['panel-browser.mjs', 'research-browser.mjs']) for (const phase of ['launch', 'browser close']) {
  test(`${file} closes its server after ${phase} failure`, async () => {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    const entry = source.indexOf('\nlet browser;') < 0 ? source.indexOf('\nconst browser =') : source.indexOf('\nlet browser;');
    assert.ok(entry > 0);
    const server = createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const failure = new Error(`Synthetic ${phase} failure`);
    const browser = { newPage: async () => { throw new Error('Stop before browser work'); }, close: async () => { throw failure; } };
    const context = vm.createContext({
      server, process: { env: {}, platform: 'synthetic' },
      chromium: { launch: async () => { if (phase === 'launch') throw failure; return browser; } },
    });
    try {
      await assert.rejects(vm.runInContext(`(async () => { ${source.slice(entry)} })()`, context), error => error === failure);
      assert.equal(server.listening, false);
    } finally {
      if (server.listening) await new Promise(resolve => server.close(resolve));
    }
  });
}

for (const file of ['browser-page.mjs', 'docs-editor-browser.mjs']) for (const phase of ['launch', 'browser close']) {
  test(`${file} cleans startup after ${phase} failure`, async () => {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    const entry = source.indexOf('\nlet browser');
    assert.ok(entry > 0);
    const server = createServer(), secondServer = createServer();
    const failure = new Error(`Synthetic ${phase} failure`);
    const browser = { newPage: async () => { throw new Error('Stop before browser work'); }, close: async () => { throw failure; } };
    const context = vm.createContext({
      server, secondServer, firstOrigin: undefined, secondOrigin: undefined,
      process: { env: {}, platform: 'synthetic' },
      chromium: { launch: async () => { if (phase === 'launch') throw failure; return browser; } },
    });
    const fragment = source.slice(entry).replaceAll('import.meta.url', JSON.stringify(new URL(file, import.meta.url).href));
    try {
      await assert.rejects(vm.runInContext(`(async () => { ${fragment} })()`, context), error => error === failure);
      assert.equal(server.listening, false);
      assert.equal(secondServer.listening, false);
    } finally {
      await Promise.all([server, secondServer].filter(item => item.listening).map(item => new Promise(resolve => item.close(resolve))));
    }
  });
}
