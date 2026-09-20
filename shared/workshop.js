/** 3.7.5 subtitle projects. No browser APIs: identity, chunking, editing and
 * translation lifecycle are exercised identically in Node and the real page. */
'use strict';
(() => {
  const S = globalThis.GXT.subs;
  const clone = value => JSON.parse(JSON.stringify(value));
  const hash = text => {
    let a = 2166136261, b = 5381;
    for (let i = 0; i < text.length; i++) { a = Math.imul(a ^ text.charCodeAt(i), 16777619); b = Math.imul(b, 33) ^ text.charCodeAt(i); }
    return `${(a >>> 0).toString(36)}-${(b >>> 0).toString(36)}-${text.length}`;
  };
  const normalize = value => String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const defaultRules = () => ({ glossary: [], characters: [], style: 'natural', instructions: '' });
  function normalizeTranslation(value = {}) {
    const number = (n, min, max, integer = false) => typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max && (!integer || Number.isInteger(n)) ? n : null;
    return { ...(globalThis.GXT.validTarget(value?.targetLang) ? {targetLang:value.targetLang} : {}), provider: ['inherit','gemini','openai','google','bing'].includes(value?.provider) ? value.provider : 'inherit',
      model: typeof value?.model === 'string' ? value.model.trim().slice(0,160).replace(/[\u0000-\u001f\u007f]/g, '') : '',
      temperature: number(value?.temperature, 0, 2),
      thinking: ['auto','off','minimal','low','medium','high'].includes(value?.thinking) ? value.thinking : 'auto',
      thinkingBudget: number(value?.thinkingBudget, -1, 32768, true),
      customPrompt: typeof value?.customPrompt === 'string' ? value.customPrompt.slice(0,6000) : '' };
  }
  function createProject(doc, name = '') {
    const items = S.collectTranslatable(doc).items;
    const rows = items.map(item => {
      const cue = doc.cues[item.index];
      const voice = /<v(?:\.[^\s>]*)?\s+([^>]+)>/.exec(cue.text || '');
      return { ...item, id: `c${item.index}-${hash(`${cue.start}:${cue.end}:${item.plain}`)}`,
        text: item.plain, start: cue.start, end: cue.end, speaker: cue.actor || voice?.[1] || '',
        translation: null, locked: false, revision: 0, status: 'pending', error: '' };
    });
    return { version: 1, id: hash(JSON.stringify([name, doc])), name, doc, rows, rules: defaultRules(),
      translation: normalizeTranslation(), undo: [], revision: 0, signature: '', created: Date.now() };
  }
  const sentenceEnd = row => /[.!?؟…。！？」”"')\]]\s*$/.test(row.text.replace(/⟦\d+⟧/g, '').trim());
  function planChunks(rows, options = {}) {
    const { targetChars = 2500, maxChars = 12000, minRows = 4, maxRows = 48, sceneGap = 3500 } = options;
    const chunks = [];
    let chunk = [], chars = 0;
    const flush = () => { if (chunk.length) chunks.push({ ids: chunk.map(r => r.id), oversized: chars > maxChars }); chunk = []; chars = 0; };
    for (const row of rows) {
      const prev = chunk[chunk.length - 1];
      if (prev) {
        const scene = row.start - prev.end >= sceneGap || row.start < prev.start;
        const speaker = row.speaker !== prev.speaker && !!(row.speaker || prev.speaker);
        const boundary = sentenceEnd(prev) && (chars >= targetChars || speaker);
        if (chunk.length >= maxRows || chars + row.text.length > maxChars || scene || (chunk.length >= minRows && boundary)) flush();
      }
      chunk.push(row); chars += row.text.length;
    }
    flush(); return chunks;
  }
  function validateEntries(rows, entries) {
    const expected = new Map(rows.map(r => [r.id, r]));
    const values = new Map(), duplicates = new Set(); let unexpected = 0;
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (!entry || !expected.has(entry.id)) { unexpected++; continue; }
      if (values.has(entry.id)) duplicates.add(entry.id);
      values.set(entry.id, entry.text);
    }
    const accepted = new Map(), invalid = [];
    for (const row of rows) {
      const value = values.get(row.id);
      if (duplicates.has(row.id) || typeof value !== 'string' || !value.trim() || value.length > 24000 ||
          !S.validTokens(value, row.tokens) || /\u0000|\n\s*\n|-->/.test(value)) invalid.push(row.id);
      else accepted.set(row.id, value.trim());
    }
    return { accepted, invalid, unexpected };
  }
  function parseRules(text) {
    return String(text || '').split('\n').map(line => {
      const at = line.indexOf('=');
      return at < 1 ? null : { source: line.slice(0, at).trim().slice(0, 120), target: line.slice(at + 1).trim().slice(0, 160) };
    }).filter(rule => rule?.source && rule?.target).slice(0, 100);
  }
  function qa(row, rules = defaultRules(), { maxCps = 20, width = 42, maxLines = 2 } = {}) {
    const issues = [];
    const text = row.translation;
    if (!text?.trim()) return ['missing'];
    if (!S.validTokens(text, row.tokens)) issues.push('formatting');
    const visible = text.replace(/⟦\s*\d+\s*⟧/g, '').replace(/[\u202a-\u202e]/g, '');
    const length = [...visible.replace(/\s/g, '')].length;
    const duration = (row.end - row.start) / 1000;
    if (!Number.isFinite(duration) || duration <= 0) issues.push('timing');
    else if (length / duration > maxCps) issues.push('reading-speed');
    if (S._internal.wrapLine(visible, width, maxLines).some(line => [...line].length > width)) issues.push('line-length');
    if (visible.split('\n').length > maxLines) issues.push('line-count');
    if (normalize(text) === normalize(row.text)) issues.push('unchanged');
    for (const rule of [...(rules.glossary || []), ...(rules.characters || [])]) {
      if (normalize(row.text).toLocaleLowerCase().includes(normalize(rule.source).toLocaleLowerCase()) && !normalize(text).includes(normalize(rule.target))) {
        issues.push('glossary'); break;
      }
    }
    if (row.status === 'error') issues.push('failed');
    return issues;
  }
  const savedFields = row => ({ id: row.id, translation: row.translation, locked: row.locked, status: row.status, error: row.error });
  function remember(project, rows) {
    project.undo.push(rows.map(savedFields));
    if (project.undo.length > 100) project.undo.shift();
  }
  function edit(project, id, text, lock = true, coalesce = false) {
    const row = project.rows.find(r => r.id === id); if (!row) return false;
    if (!coalesce) remember(project, [row]); row.translation = String(text).slice(0, 24000); row.locked = lock;
    row.status = row.translation.trim() ? 'manual' : 'pending'; row.error = ''; row.revision++; project.revision++; return true;
  }
  function lock(project, id, value) {
    const row = project.rows.find(r => r.id === id); if (!row) return;
    remember(project, [row]); row.locked = !!value; row.revision++; project.revision++;
  }
  function replace(project, find, replacement, ids = null) {
    if (!find) return 0;
    const selection = ids && new Set(ids);
    const rows = project.rows.filter(r => !r.locked && (!selection || selection.has(r.id)) && r.translation?.includes(find));
    if (!rows.length) return 0;
    remember(project, rows);
    for (const row of rows) { row.translation = row.translation.split(find).join(replacement).slice(0, 24000); row.locked = true; row.status = 'manual'; row.revision++; }
    project.revision++; return rows.length;
  }
  function undo(project) {
    const patch = project.undo.pop(); if (!patch) return false;
    const byId = new Map(project.rows.map(r => [r.id, r]));
    for (const value of patch) { const row = byId.get(value.id); if (row) { Object.assign(row, value); row.revision++; } }
    project.revision++; return true;
  }
  function memoryIndex(project) {
    const index = new Map();
    for (const row of project.rows) {
      if (!row.locked || !row.translation || !S.validTokens(row.translation, row.tokens)) continue;
      const key = JSON.stringify([normalize(row.text), row.speaker]);
      if (!index.has(key)) index.set(key, []);
      index.get(key).push({ id: row.id, translation: row.translation });
    }
    return index;
  }
  function suggestions(project, row, index = memoryIndex(project)) {
    return [...new Set((index.get(JSON.stringify([normalize(row.text), row.speaker])) || []).filter(other => other.id !== row.id).map(other => other.translation))];
  }
  function snapshot(project) {
    return { version: 1, id: project.id, name: project.name, doc: clone(project.doc), rules: clone(project.rules),
      translation: normalizeTranslation(project.translation), rows: project.rows.map(savedFields), revision: project.revision, signature: project.signature, savedAt: Date.now() };
  }
  function restore(value) {
    if (value?.version !== 1 || !value.doc || !Array.isArray(value.doc.cues) || value.doc.cues.length > 300000 || !Array.isArray(value.rows)) throw Error(globalThis.GXT.i18n.t("shared_workshop_restore_4"));
    if (value.doc.cues.some(c => !Number.isSafeInteger(c?.start) || !Number.isSafeInteger(c?.end) || c.start < 0 || c.end < 0)) throw Error(globalThis.GXT.i18n.t("shared_workshop_restore_3"));
    const project = createProject(value.doc, String(value.name || ''));
    if (value.id !== project.id || value.rows.length !== project.rows.length || value.rows.some((r, i) => r?.id !== project.rows[i].id)) throw Error(globalThis.GXT.i18n.t("shared_workshop_restore_2"));
    if (project.rows.some(r => !Number.isSafeInteger(r.start) || !Number.isSafeInteger(r.end) || r.start < 0 || r.end <= r.start)) throw Error(globalThis.GXT.i18n.t("shared_workshop_restore_1"));
    value.rows.forEach((saved, i) => {
      const row = project.rows[i];
      row.translation = typeof saved.translation === 'string' ? saved.translation.slice(0, 24000) : null;
      row.locked = saved.locked === true; row.status = row.translation ? (row.locked ? 'manual' : 'ready') : 'pending';
    });
    const sanitize = entries => (Array.isArray(entries) ? entries : []).slice(0, 100).filter(r => typeof r?.source === 'string' && typeof r?.target === 'string').map(r => ({ source: r.source.slice(0, 120), target: r.target.slice(0, 160) }));
    project.rules = { glossary: sanitize(value.rules?.glossary), characters: sanitize(value.rules?.characters),
      style: ['natural','formal','colloquial'].includes(value.rules?.style) ? value.rules.style : 'natural', instructions: String(value.rules?.instructions || '').slice(0, 1500) };
    project.signature = typeof value.signature === 'string' ? value.signature.slice(0, 200) : '';
    project.translation = normalizeTranslation(value.translation);
    return project;
  }
  class Session {
    constructor(project) { this.project = project; this.epoch = 0; this.active = false; this.pending = new Map(); this.prefix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`; }
    cancel() {
      this.epoch++; this.active = false;
      for (const [id, value] of this.pending) { value.cancel?.(id); value.release({ ok: false, code: 'CANCELLED' }); }
      this.pending.clear();
      for (const row of this.project.rows) if (row.status === 'translating') row.status = row.translation ? 'ready' : 'pending';
    }
    async run(transport, { ids = null, force = false, cancel, onUpdate = () => {}, chunkOptions = {}, deadlineMs = 90000 } = {}) {
      this.cancel(); this.active = true; const epoch = this.epoch, project = this.project;
      const wanted = ids && new Set(ids), byId = new Map(project.rows.map(r => [r.id, r]));
      const selected = project.rows.filter(r => !r.locked && (!wanted || wanted.has(r.id)) && (force || !r.translation || r.status === 'error'));
      const selectedIds = new Set(selected.map(r => r.id));
      // Plan against the complete dialogue, including locked and completed
      // lines. Selection narrows output only; it never removes the context.
      const chunks = planChunks(project.rows, chunkOptions).filter(c => c.ids.some(id => selectedIds.has(id)));
      const indexById = new Map(project.rows.map((r, i) => [r.id, i]));
      const progress = { total: selected.length, done: 0, failed: 0, repaired: 0, chunks: chunks.length, chunk: 0, error: '' };
      const cue = row => ({ id: row.id, text: row.text, start: row.start, end: row.end, speaker: row.speaker,
        ...(row.translation && S.validTokens(row.translation, row.tokens) ? { translated: row.translation } : {}) });
      const context = (first, last, requested) => {
        let budget = 6000;
        const cap = list => list.map(row => cue(row)).filter(entry => { const n = entry.text.length + (entry.translated?.length || 0); if (n > budget) return false; budget -= n; return true; });
        const between = project.rows.slice(first, last + 1).filter(r => !requested.has(r.id)).slice(0, 3);
        return { contextBefore: cap([...project.rows.slice(Math.max(0, first - (6 - between.length)), first), ...between].reverse()).reverse(), contextAfter: cap(project.rows.slice(last + 1, last + 3)) };
      };
      let sequence = 0;
      const request = async (rows, repair) => {
        if (!rows.length || this.epoch !== epoch) return [];
        const revisions = new Map(rows.map(r => [r.id, r.revision]));
        rows.forEach(r => { r.status = 'translating'; r.error = ''; }); onUpdate(progress);
        const first = Math.min(...rows.map(r => indexById.get(r.id))), last = Math.max(...rows.map(r => indexById.get(r.id)));
        const requestId = `${this.prefix}-${epoch}-${sequence++}`;
        const message = { type: 'TRANSLATE_WORKSHOP', source: 'file', requestId, projectId: project.id,
          cues: rows.map(cue), ...context(first, last, new Set(rows.map(r => r.id))), rules: clone(project.rules), translation: normalizeTranslation(project.translation), repair };
        let timeout;
        const retired = new Promise(resolve => {
          this.pending.set(requestId, { release: resolve, cancel });
          timeout = setTimeout(() => { cancel?.(requestId); resolve({ ok: false, code: 'TIMEOUT', get error() { return globalThis.GXT.i18n.t("shared_workshop_retired_1"); } }); }, deadlineMs);
        });
        let response;
        try { response = await Promise.race([Promise.resolve().then(() => this.epoch === epoch ? transport(message) : { ok: false, code: 'CANCELLED' }).catch(error => ({ ok: false, error: String(error?.message || error) })), retired]); }
        finally { clearTimeout(timeout); this.pending.delete(requestId); }
        if (this.epoch !== epoch) return [];
        const validation = validateEntries(rows, response?.ok ? response.entries : []);
        const invalid = [];
        for (const row of rows) {
          if (row.revision !== revisions.get(row.id) || row.locked) continue;
          const text = validation.accepted.get(row.id);
          if (text !== undefined) { row.translation = text; row.status = 'ready'; row.error = ''; if (repair) progress.repaired++; }
          else { row.status = 'error'; row.error = response?.error || globalThis.GXT.i18n.t("shared_workshop_request_2"); invalid.push(row); }
        }
        project.revision++;
        if (!response?.ok && response?.code !== 'BAD_RESPONSE') progress.error = response?.error || globalThis.GXT.i18n.t("shared_workshop_request_1");
        onUpdate(progress);
        return response?.ok || response?.code === 'BAD_RESPONSE' ? invalid : null;
      };
      try {
        onUpdate(progress);
        for (const chunk of chunks) {
          if (this.epoch !== epoch) break;
          const rows = chunk.ids.filter(id => selectedIds.has(id)).map(id => byId.get(id)).filter(r => !r.locked);
          if (rows.some(r => r.text.length > 12000)) {
            rows.forEach(r => { r.status = 'error'; r.error = globalThis.GXT.i18n.t("shared_workshop_message_1"); });
            progress.done += rows.length; progress.failed += rows.length; progress.chunk++; onUpdate(progress); continue;
          }
          const invalid = await request(rows, false);
          if (this.epoch !== epoch) break;
          if (invalid?.length) await request(invalid.filter(r => !r.locked), true);
          if (this.epoch !== epoch) break;
          progress.done += rows.length; progress.failed += rows.filter(r => r.status === 'error').length; progress.chunk++;
          onUpdate(progress); if (invalid === null) break;
        }
      } finally { if (this.epoch === epoch) { this.active = false; onUpdate(progress); } }
      return progress;
    }
  }
  globalThis.GXT.workshop = { normalizeTranslation, createProject, planChunks, validateEntries, parseRules, qa, edit, lock, replace, undo, suggestions, memoryIndex, snapshot, restore, Session, hash };
})();
