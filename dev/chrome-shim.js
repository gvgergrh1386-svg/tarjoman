/**
 * Dev-only chrome.* shim so the extension's content scripts and background
 * modules can run inside a plain test page. Never shipped to the extension —
 * Chrome ignores this folder entirely (nothing in the manifest points here).
 *
 * Pages may define, before loading this file:
 *   globalThis.GXT_SHIM_SEED     initial chrome.storage.local contents
 *   globalThis.GXT_SHIM_HANDLER  async (message) => response, for sendMessage
 */
'use strict';
(() => {
  if (globalThis.chrome?.runtime?.id) return;

  const mem = Object.assign({}, globalThis.GXT_SHIM_SEED || {});
  const changeListeners = [];

  function emitChanges(patch) {
    const changes = {};
    for (const key of Object.keys(patch)) changes[key] = { newValue: patch[key] };
    for (const listener of changeListeners) {
      try {
        listener(changes, 'local');
      } catch (e) {
        console.error('shim listener error', e);
      }
    }
  }

  const messageListeners = [];
  /** Test pages call this to simulate a message FROM the service worker.
   *  An optional `respond` callback receives whatever the listener sends back,
   *  so request/response handlers (e.g. the VSR report) can be tested too. */
  globalThis.GXT_SHIM_DISPATCH = (message, respond) => {
    for (const listener of messageListeners) {
      try {
        listener(message, { id: 'dev-shim' }, respond || (() => {}));
      } catch (e) {
        console.error('shim onMessage listener error', e);
      }
    }
  };

  globalThis.chrome = {
    runtime: {
      id: 'dev-shim',
      getURL: (path) => `../${path}`,
      /**
       * Both calling conventions, because the codebase legitimately uses both:
       * most callers await the promise, while content/ui.js passes a CALLBACK
       * (it has to read chrome.runtime.lastError, which only exists there).
       * Supporting the promise alone left the speech player waiting forever in
       * its "loading" state under test — a harness gap that looked exactly
       * like a hung feature.
       */
      sendMessage(message, callback) {
        const handler = globalThis.GXT_SHIM_HANDLER;
        const result = Promise.resolve(
          handler ? handler(message) : { ok: false, code: 'DEV' }
        );
        if (typeof callback === 'function') {
          result.then(callback, () => callback(undefined));
          return undefined;
        }
        return result;
      },
      /** Present but never set: the callback path reads it on every reply. */
      lastError: undefined,
      /**
       * Long-lived ports (v3.1.0).
       *
       * The audio-native dubbing path talks to the worker over a Port rather
       * than one-shot messages — it carries ~10 audio chunks a second each way.
       * The shim had no `connect` at all, so that entire engine was untestable,
       * which is a large part of why a bug that disabled it went unnoticed. A
       * page supplies `GXT_SHIM_CONNECT(name)` to observe or drive the session;
       * without one, a inert port is returned so nothing throws.
       */
      connect(info) {
        const name = typeof info === 'string' ? info : info?.name || '';
        const factory = globalThis.GXT_SHIM_CONNECT;
        if (typeof factory === 'function') return factory(name);
        return {
          name,
          postMessage() {},
          disconnect() {},
          onMessage: { addListener() {}, removeListener() {} },
          onDisconnect: { addListener() {}, removeListener() {} },
        };
      },
      onMessage: {
        addListener(listener) {
          messageListeners.push(listener);
        },
      },
    },
    permissions: {
      async request() {
        return true;
      },
    },
    storage: {
      local: {
        async get(query) {
          if (query == null) return { ...mem };
          if (typeof query === 'string') {
            return query in mem ? { [query]: mem[query] } : {};
          }
          if (Array.isArray(query)) {
            const out = {};
            for (const key of query) if (key in mem) out[key] = mem[key];
            return out;
          }
          const out = {};
          for (const [key, fallback] of Object.entries(query)) {
            out[key] = key in mem ? mem[key] : fallback;
          }
          return out;
        },
        async set(patch) {
          Object.assign(mem, patch);
          emitChanges(patch);
        },
        async remove(keys) {
          for (const key of [].concat(keys)) delete mem[key];
        },
      },
      onChanged: {
        addListener(listener) {
          changeListeners.push(listener);
        },
      },
    },
  };
})();
