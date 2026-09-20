/**
 * Synthesized-audio cache (v2.2.0).
 *
 * Separate from background/cache.js on purpose. That cache stores short
 * strings in chrome.storage.local; audio is three orders of magnitude larger
 * (a minute of Persian speech is ~180 KB of MP3) and storing it there would
 * evict the entire translation cache within a couple of articles — the exact
 * mistake v1.9.6 fixed for prompt versions. IndexedDB handles binary-sized
 * values without that pressure, and the two caches now age independently.
 *
 * The payoff is bigger than it looks: audio is the most expensive thing this
 * extension produces. Re-reading a page, replaying a paragraph, or (later)
 * rewatching a dubbed video costs nothing at all on a hit — no request, no
 * quota, no latency.
 *
 * Eviction is LRU by total BYTES, not by entry count: entries here differ in
 * size by 100×, so counting them would be meaningless.
 */
'use strict';
(() => {
  globalThis.GXT = globalThis.GXT || {};

  const DB_NAME = 'gxt-audio';
  const DB_VERSION = 1;
  const STORE = 'clips';
  const DEFAULT_MAX_BYTES = 250 * 1024 * 1024;
  // Evicting to exactly the cap would re-trigger a prune on the very next
  // write. Dropping to 75% makes pruning rare.
  const TRIM_RATIO = 0.75;

  let dbPromise = null;
  let maxBytes = DEFAULT_MAX_BYTES;
  let generation = 0;

  /**
   * Adopt the user's ceiling (settings.ttsCacheMb).
   *
   * The setting existed from v2.2.0 and was never read by anything: the cache
   * always used its 250 MB default, so a user who lowered it kept filling the
   * disk and one who raised it kept losing clips. Clamped, because a 0 would
   * evict every clip on the write that created it and an unbounded value is
   * not a ceiling.
   */
  function setMaxMb(mb) {
    const n = Number(mb);
    if (!Number.isFinite(n) || n <= 0) {
      maxBytes = DEFAULT_MAX_BYTES;
      return maxBytes;
    }
    maxBytes = Math.max(16, Math.min(4096, n)) * 1024 * 1024;
    return maxBytes;
  }

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'k' });
          // Eviction scans in access order; the index makes that a cursor walk
          // instead of reading every clip into memory.
          store.createIndex('ts', 'ts');
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }).catch((error) => {
      // A blocked/unavailable IndexedDB must never break playback — the
      // feature degrades to "no cache", not "no sound".
      dbPromise = null;
      throw error;
    });
    return dbPromise;
  }

  const tx = async (mode, fn) => {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const store = transaction.objectStore(STORE);
      let result;
      try { result = fn(store); } catch (error) { reject(error); return; }
      transaction.oncomplete = () => resolve(result && result.__req ? result.__req.result : result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  };

  const wrap = (request) => ({ __req: request });

  async function sha256Hex(str) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 40);
  }

  /**
   * Cache key for one clip. EVERY input that changes the waveform is in it —
   * engine, voice, model, speaking rate, delivery style, text. Change any one
   * and you get a different clip rather than a stale one.
   */
  function keyFor({ text, engine, voice, model, rate, style, endpoint }) {
    return sha256Hex(
      JSON.stringify([engine || '', endpoint || '', voice || '', model || '', rate == null ? '' : String(rate), (style || '').trim(), text])
    );
  }

  /** @returns {Promise<{mime:string,data:string}|null>} */
  async function get(key) {
    const readingGeneration = generation;
    try {
      const entry = await tx('readonly', (store) => wrap(store.get(key)));
      if (!entry || readingGeneration !== generation) return null;
      // Touch asynchronously: a cache read must not wait on a write.
      void tx('readwrite', (store) => {
        if (readingGeneration !== generation) return;
        // Re-read inside the write transaction. Rewriting the earlier snapshot
        // can resurrect a cleared clip or overwrite a newer synthesis.
        const request = store.get(key);
        request.onsuccess = () => {
          if (request.result && readingGeneration === generation) {
            store.put({ ...request.result, ts: Date.now() });
          }
        };
      }).catch(() => {});
      return { mime: entry.mime, data: entry.data };
    } catch {
      return null;
    }
  }

  async function put(key, { mime, data }, { generation: writingGeneration = generation } = {}) {
    try {
      await tx('readwrite', (store) => {
        if (writingGeneration !== generation) return;
        store.put({ k: key, mime, data, bytes: data.length, ts: Date.now() });
      });
      void prune().catch(() => {});
    } catch {
      /* cache write failures are never fatal */
    }
  }

  /** Total stored bytes, and the number of clips. */
  async function stats() {
    try {
      let bytes = 0;
      let count = 0;
      await tx('readonly', (store) => {
        const cursorRequest = store.openCursor();
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) return;
          bytes += cursor.value.bytes || 0;
          count += 1;
          cursor.continue();
        };
      });
      return { bytes, count };
    } catch {
      return { bytes: 0, count: 0 };
    }
  }

  async function prune() {
    await tx('readwrite', (store) => {
      // Count and evict in the same transaction. Separate read/write snapshots
      // let several concurrent prunes each delete the original excess again.
      const limit = maxBytes;
      let remaining = 0;
      const countRequest = store.openCursor();
      countRequest.onsuccess = () => {
        const cursor = countRequest.result;
        if (!cursor) {
          if (remaining <= limit) return;
          const eviction = store.index('ts').openCursor();
          eviction.onsuccess = () => {
            const oldest = eviction.result;
            if (!oldest || remaining <= limit * TRIM_RATIO) return;
            remaining -= oldest.value.bytes || 0;
            oldest.delete();
            oldest.continue();
          };
          return;
        }
        remaining += cursor.value.bytes || 0;
        cursor.continue();
      };
    });
  }

  async function clearAll() {
    generation += 1;
    try {
      await tx('readwrite', (store) => { store.clear(); });
      return true;
    } catch {
      return false;
    }
  }

  globalThis.GXT.audioCache = {
    keyFor,
    get,
    put,
    stats,
    clearAll,
    generation: () => generation,
    setMaxMb,
    _internal: {
      prune,
      setMaxBytes: (n) => { maxBytes = n; },
      maxBytes: () => maxBytes,
      DEFAULT_MAX_BYTES,
    },
  };
})();
