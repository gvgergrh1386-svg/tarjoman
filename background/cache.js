/**
 * Two-layer translation cache.
 *
 * L1: in-memory LRU Map (fast, dies with the service worker).
 * L2: chrome.storage.local entries keyed by a SHA-256 of
 *     (promptVersion, providerModelId, sourceLang, text), LRU-pruned by
 *     timestamp. Values are {t: translation, sl: detected source language}.
 */
'use strict';
(() => {
  globalThis.GXT = globalThis.GXT || {};

  const ENTRY_PREFIX = 't:';
  const COUNT_KEY = 'cacheCount';
  // v1.8: raised (with the unlimitedStorage permission) so one long video's
  // subtitles (~2000 cues) can no longer evict the whole tweet cache.
  const MAX_ENTRIES = 20000;
  const TRIM_TO = 16000;
  const MAX_MEM = 1500;
  const TOUCH_INTERVAL_MS = 24 * 60 * 60 * 1000;
  const MAX_INFLIGHT = 256;
  const MAX_FLIGHT_AGE_MS = 2 * 60 * 1000;

  /** @type {Map<string, {t:string, sl:string}>} LRU by re-insertion */
  const mem = new Map();
  let generation = 0;
  let clearing = 0;
  const writing = new Map();
  // Pending exact requests only. A completed/failing operation is never kept
  // here: persisted translations keep using their existing validated cache.
  const inflight = new Map();
  const flightStats = { started: 0, shared: 0, bypassed: 0, expired: 0 };

  function coalesce(key, produce, { generation: requestGeneration = generation } = {}) {
    const now = Date.now();
    for (const [id, entry] of inflight) {
      if (now - entry.started >= MAX_FLIGHT_AGE_MS) { inflight.delete(id); flightStats.expired += 1; }
    }
    const id = `${requestGeneration}:${key}`;
    const existing = inflight.get(id);
    if (existing) { flightStats.shared += 1; return existing.promise; }
    // Saturation or a clear during request preparation must not attach old
    // work to the new generation. Bypass sharing; the owner's cache-write
    // generation still prevents it restoring data that the user cleared.
    if (requestGeneration !== generation || inflight.size >= MAX_INFLIGHT) {
      flightStats.bypassed += 1;
      return Promise.resolve().then(produce);
    }
    const entry = { started: now, promise: null };
    flightStats.started += 1;
    entry.promise = Promise.resolve().then(produce).finally(() => {
      // An expired or cleared operation may finish after a replacement.
      if (inflight.get(id) === entry) inflight.delete(id);
    });
    inflight.set(id, entry);
    return entry.promise;
  }

  async function sha256Hex(str) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, 40);
  }

  /**
   * Cache key for one string.
   *
   * @param {string} text     the source text
   * @param {string} lang     source language ('auto', 'en', …) for the tweet
   *                          pipeline, or a task tag ('g6', 'image', 'summary')
   *                          for the others
   * @param {string} modelId  provider+model (+personalization) namespace
   * @param {number} [version] prompt version to bind the entry to. Defaults to
   *   the TWEET prompt version, which is right for the tweet pipeline only.
   *   The other pipelines pass 0 and carry their own version inside `lang`
   *   (e.g. 'g6') — before v1.9.6 every key embedded the tweet version, so
   *   bumping the tweet prompt silently threw away the page, subtitle, image
   *   and summary caches too (pure waste: those prompts hadn't changed).
   */
  async function keyFor(text, lang, modelId, version) {
    const v =
      version === undefined
        ? globalThis.GXT.prompt
          ? globalThis.GXT.prompt.PROMPT_VERSION
          : 0
        : version;
    return ENTRY_PREFIX + (await sha256Hex(JSON.stringify([v, modelId, lang, text])));
  }

  function memGet(key) {
    if (!mem.has(key)) return undefined;
    const value = mem.get(key);
    mem.delete(key);
    mem.set(key, value);
    return value;
  }

  function memSet(key, value) {
    if (mem.has(key)) mem.delete(key);
    mem.set(key, value);
    if (mem.size > MAX_MEM) mem.delete(mem.keys().next().value);
  }

  /**
   * @param {string[]} keys
   * @returns {Promise<Object<string, {t:string, sl:string}>>} hits only
   */
  async function getMany(keys) {
    // Hot hits are independent of unrelated disk accounting. Wait only if a
    // clear or a write to THIS key can change the answer.
    if (!clearing && keys.every(key => mem.has(key) && !writing.has(key))) {
      return Object.fromEntries(keys.map(key => [key, memGet(key)]));
    }
    await countQueue;
    const readingGeneration = generation;
    const out = {};
    const missing = [];
    for (const key of keys) {
      const value = memGet(key);
      if (value !== undefined) out[key] = value;
      else missing.push(key);
    }
    if (missing.length) {
      let stored;
      try { stored = await chrome.storage.local.get(missing); }
      catch {
        // Disk caching is optional. Keep usable L1 hits, and let unresolved
        // items reach the provider rather than failing before translation.
        return readingGeneration === generation ? out : {};
      }
      // A clear that happened during the disk read owns the new generation.
      // Neither these hits nor an asynchronous LRU touch may revive old data.
      if (readingGeneration !== generation) return {};
      const now = Date.now();
      const touched = {};
      for (const key of missing) {
        const entry = stored[key];
        if (entry && typeof entry.t === 'string') {
          const value = { t: entry.t, sl: entry.sl || '' };
          out[key] = value;
          memSet(key, value);
          // Refresh the LRU timestamp at most once a day to limit writes.
          if (now - (entry.ts || 0) > TOUCH_INTERVAL_MS) touched[key] = { ...entry, ts: now };
        }
      }
      if (Object.keys(touched).length) void withCount(async () => {
        if (readingGeneration !== generation) return;
        const latest = await chrome.storage.local.get(Object.keys(touched));
        const patch = {};
        for (const key of Object.keys(touched)) {
          if (latest[key]) patch[key] = { ...latest[key], ts: Date.now() };
        }
        if (Object.keys(patch).length) await chrome.storage.local.set(patch);
      }).catch(() => {});
    }
    return out;
  }

  /**
   * The entry counter is a read-modify-write of ONE storage key, and it is
   * written from calls that genuinely overlap: a tweet batch fans its groups
   * out through Promise.all, a page run keeps three chunks in flight, and a
   * YouTube track translates while either of those is happening. Unserialized,
   * two writers both read the same old count and the second one discards the
   * first's increment — so the counter drifts permanently BELOW the truth, and
   * `count > MAX_ENTRIES` is the only thing that ever triggers a prune. The
   * cache therefore grew past its 20 000-entry ceiling without bound (the
   * `unlimitedStorage` permission means nothing stops it), which is the same
   * class of bug already fixed for stats and for settings.
   *
   * One queue for payloads, accounting and clear. Serializing only the counter
   * leaves a clear racing the payload write and double-counts simultaneous
   * writes of the same key.
   */
  let countQueue = Promise.resolve();

  function withCount(fn) {
    const result = countQueue.then(fn);
    countQueue = result.catch(() => {});
    return result;
  }

  /** @param {Array<[string, {t:string, sl:string}]>} pairs */
  async function setMany(pairs, { generation: writingGeneration = generation, accept = () => true } = {}) {
    if (!pairs.length) return;
    const pendingKeys = [...new Set(pairs.map(([key]) => key))];
    for (const key of pendingKeys) writing.set(key, (writing.get(key) || 0) + 1);
    await withCount(async () => {
      if (writingGeneration !== generation || !accept()) return;
      const unique = new Map(pairs);
      const existing = await chrome.storage.local.get([...unique.keys()]);
      if (writingGeneration !== generation || !accept()) return;
      const now = Date.now();
      const patch = {};
      let added = 0;
      for (const [key, value] of unique) {
        if (!(key in existing)) added += 1;
        patch[key] = { t: value.t, sl: value.sl || '', ts: now };
      }
      await chrome.storage.local.set(patch);
      for (const [key, value] of unique) memSet(key, { t: value.t, sl: value.sl || '' });
      if (!added) return;
      const raw = await chrome.storage.local.get({ [COUNT_KEY]: 0 });
      const count = (raw[COUNT_KEY] || 0) + added;
      await chrome.storage.local.set({ [COUNT_KEY]: count });
      // Inside the queue too: a prune rewrites the counter, and a concurrent
      // increment landing between its scan and its write would restore a stale
      // total and re-arm the prune immediately.
      if (count > MAX_ENTRIES) await prune();
    }).catch(() => {}).finally(() => {
      for (const key of pendingKeys) {
        const count = writing.get(key) - 1;
        if (count) writing.set(key, count); else writing.delete(key);
      }
    }); // Translation succeeds even when an optional cache write fails.
  }

  async function prune() {
    const all = await chrome.storage.local.get(null);
    const entries = Object.entries(all).filter(
      ([key, value]) => key.startsWith(ENTRY_PREFIX) && value && typeof value.t === 'string'
    );
    if (entries.length > TRIM_TO) {
      entries.sort((a, b) => (a[1].ts || 0) - (b[1].ts || 0));
      const remove = entries.slice(0, entries.length - TRIM_TO).map(([key]) => key);
      await chrome.storage.local.remove(remove);
      for (const key of remove) mem.delete(key);
      await chrome.storage.local.set({ [COUNT_KEY]: TRIM_TO });
    } else {
      await chrome.storage.local.set({ [COUNT_KEY]: entries.length });
    }
  }

  function clearAll() {
    generation += 1;
    clearing += 1;
    inflight.clear();
    mem.clear();
    // Rides the same queue as setMany: a "clear" that raced an in-flight
    // increment used to leave the counter non-zero over an empty cache.
    return withCount(async () => {
      mem.clear();
      const all = await chrome.storage.local.get(null);
      const keys = Object.keys(all).filter((key) => key.startsWith(ENTRY_PREFIX));
      if (keys.length) await chrome.storage.local.remove(keys);
      await chrome.storage.local.set({ [COUNT_KEY]: 0 });
    }).finally(() => { clearing -= 1; });
  }

  globalThis.GXT.cache = {
    keyFor,
    getMany,
    setMany,
    clearAll,
    coalesce,
    generation: () => generation,
    _internal: { prune, MAX_ENTRIES, TRIM_TO, ENTRY_PREFIX, COUNT_KEY, MAX_INFLIGHT, MAX_FLIGHT_AGE_MS,
      inflightCount: () => inflight.size, flightStats: () => ({ ...flightStats }) },
  };
})();
