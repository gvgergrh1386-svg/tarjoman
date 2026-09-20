/**
 * Subtitle file engine (v2.3.0): parse → translate → rebuild, for SRT, WebVTT
 * and ASS/SSA.
 *
 * Pure functions only — no DOM, no chrome APIs — so the whole thing is unit
 * testable and could later run in the worker as easily as in the page.
 *
 * The three problems this file exists to solve, none of which are obvious:
 *
 *  1. FORMATTING IS NOT TEXT. An ASS line is `{\i1}Hello{\i0}\Nworld`, an SRT
 *     line can be `<i>Hello</i>`. Send that to a translator and it comes back
 *     mangled — tags reordered, `\N` turned into a real newline, drawing
 *     commands "translated". Everything non-textual is therefore swapped for a
 *     ⟦n⟧ placeholder before translation and restored after, reusing exactly
 *     the token convention the rest of the extension already teaches the model
 *     (and `repairTokens` in mt.js already heals).
 *
 *  2. PERSIAN PUNCTUATION RENDERS BACKWARDS. `سلام!` at the end of a line
 *     shows as `!سلام` in mpv, VLC and most renderers, because the `!` is a
 *     direction-neutral character sitting in a paragraph the player assumes is
 *     left-to-right. Every Persian subtitle group hits this. The fix is to
 *     wrap each rendered line in U+202B … U+202C so the line is explicitly a
 *     right-to-left run.
 *
 *  3. LINE BREAKS DO NOT SURVIVE TRANSLATION. English wraps where English
 *     wraps; the Persian sentence has a different shape entirely. Keeping the
 *     original break positions produces lines split mid-phrase, so a cue is
 *     joined into one sentence for translation and re-wrapped afterwards on
 *     the Persian text's own balance point.
 */
'use strict';
(() => {
  globalThis.GXT = globalThis.GXT || {};

  // U+202B RIGHT-TO-LEFT EMBEDDING / U+202C POP DIRECTIONAL FORMATTING.
  const RLE = '‫';
  const PDF = '‬';

  // ------------------------------------------------------------- encoding

  /**
   * Decode a subtitle file's bytes.
   *
   * Most Persian and Arabic subtitles in circulation predate UTF-8 and are
   * windows-1256; opening one as UTF-8 yields a screen of replacement
   * characters. Strict UTF-8 first (it fails loudly on non-UTF-8 input, which
   * is exactly what makes it a reliable test), then the legacy codepage.
   *
   * @param {ArrayBuffer} buffer
   * @returns {{text: string, encoding: string}}
   */
  function decodeBytes(buffer) {
    const bytes = new Uint8Array(buffer);
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'utf-8 (BOM)' };
    }
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
      return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'utf-16le' };
    }
    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'utf-16be' };
    }
    try {
      return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' };
    } catch {
      return { text: new TextDecoder('windows-1256').decode(bytes), encoding: 'windows-1256' };
    }
  }

  // ---------------------------------------------------------------- time

  const pad = (n, w = 2) => String(Math.floor(n)).padStart(w, '0');

  /** `HH:MM:SS,mmm` / `HH:MM:SS.mmm` / `H:MM:SS.cc` → milliseconds. */
  function parseTime(raw) {
    const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})(?=\s|$)/.exec(String(raw || '').trim());
    if (!m) return null;
    if (Number(m[2]) > 59 || Number(m[3]) > 59) return null;
    const frac = m[4];
    // ASS uses centiseconds, SRT/VTT milliseconds — pad by written width, so
    // `.50` is 500 ms and `.5` is 500 ms, but `.050` is 50 ms.
    const ms = frac.length === 3 ? Number(frac) : Number(frac) * (frac.length === 2 ? 10 : 100);
    const value = ((Number(m[1] || 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + ms;
    return Number.isSafeInteger(value) ? value : null;
  }

  function formatTime(ms, format) {
    const total = Math.max(0, Math.round(ms));
    const h = Math.floor(total / 3600000);
    const min = Math.floor(total / 60000) % 60;
    const sec = Math.floor(total / 1000) % 60;
    const milli = total % 1000;
    if (format === 'ass') return `${h}:${pad(min)}:${pad(sec)}.${pad(milli / 10)}`;
    if (format === 'vtt') return `${pad(h)}:${pad(min)}:${pad(sec)}.${pad(milli, 3)}`;
    return `${pad(h)}:${pad(min)}:${pad(sec)},${pad(milli, 3)}`;
  }

  // ------------------------------------------------------- tokenizing text

  // ASS override blocks `{...}`, hard break `\N`, soft break `\n`, hard space
  // `\h`. SRT/VTT carry a small HTML subset instead. Both are matched here so
  // one tokenizer serves every format.
  const TOKEN_RE = /\{[^}]*\}|\\[Nnh]|<\/?[a-zA-Z][^>]*>|<(?:\d+:)?\d{2}:\d{2}\.\d{3}>/g;

  /**
   * Replace every non-textual run with a ⟦n⟧ placeholder.
   * @returns {{plain: string, tokens: string[]}}
   */
  function tokenize(text) {
    const tokens = [];
    const plain = String(text || '').replace(TOKEN_RE, (match) => {
      tokens.push(match);
      return `⟦${tokens.length - 1}⟧`;
    });
    return { plain, tokens };
  }

  /**
   * Put the tokens back. A model that drops a placeholder must not silently
   * lose the formatting it stood for, so anything missing is appended at the
   * end rather than discarded — a stray `{\i0}` at the end of a line is
   * invisible to the viewer, a lost `\N` is not.
   */
  function detokenize(plain, tokens) {
    const used = new Set();
    let out = String(plain || '').replace(/⟦\s*(\d+)\s*⟧/g, (match, n) => {
      const index = Number(n);
      if (!Number.isInteger(index) || index < 0 || index >= tokens.length) return '';
      used.add(index);
      return tokens[index];
    });
    for (let i = 0; i < tokens.length; i += 1) {
      // Only line breaks are worth rescuing; a dropped style tag at the end
      // would do nothing but add noise.
      if (!used.has(i) && /^\\[Nn]$/.test(tokens[i])) out += tokens[i];
    }
    return out;
  }

  // The workbench validates before accepting model OR manual output. Keep the
  // legacy low-level detokenizer tolerant for its other callers, but never let
  // a file export silently discard or duplicate its formatting instructions.
  function validTokens(plain, tokens = []) {
    const found = [...String(plain || '').matchAll(/⟦\s*(\d+)\s*⟧/g)].map(m => Number(m[1]));
    return found.length === tokens.length && found.every((n, i) => n === i);
  }

  // ------------------------------------------------------- line treatment

  /** Text that carries no letters (music glyphs, dashes, numbers) has nothing
   *  to translate; sending it wastes a slot and invites hallucination. */
  const HAS_LETTERS = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿ֐-׿؀-ۿ぀-ヿ一-鿿]/;

  const isTranslatable = (plain) => HAS_LETTERS.test(String(plain || '').replace(/⟦\d+⟧/g, ''));

  /**
   * Re-wrap a translated line into at most `maxLines` display lines, breaking
   * at the most balanced space. Persian words are longer on average than
   * English ones, so a naive width cut strands a single word on line two.
   */
  function wrapLine(text, width = 42, maxLines = 2) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (clean.length <= width || maxLines < 2) return [clean];
    // Balance point: the space nearest the middle, so the two lines are of
    // similar length rather than one full and one nearly empty.
    const mid = Math.floor(clean.length / 2);
    let best = -1;
    for (let i = 0; i < clean.length; i += 1) {
      if (clean[i] !== ' ') continue;
      if (best === -1 || Math.abs(i - mid) < Math.abs(best - mid)) best = i;
    }
    if (best <= 0) return [clean];
    const head = clean.slice(0, best).trim();
    const tail = clean.slice(best + 1).trim();
    if (maxLines === 2 || tail.length <= width) return [head, tail];
    return [head, ...wrapLine(tail, width, maxLines - 1)];
  }

  /**
   * Force a rendered line to be a right-to-left run.
   *
   * Leading ASS override blocks stay OUTSIDE the mark: they are instructions
   * to the renderer, not text, and `{\an8}` must still be parsed as a tag.
   */
  function rtlWrap(line) {
    const text = String(line || '');
    if (!text.trim()) return text;
    // Override blocks at either end are instructions to the renderer, not
    // text — they stay outside the marks so nothing can mis-parse them, and
    // so the embedding covers exactly the characters that need it.
    const m = /^((?:\{[^}]*\})*)([\s\S]*?)((?:\{[^}]*\})*)$/.exec(text);
    const lead = m[1] || '';
    const body = m[2] || '';
    const trail = m[3] || '';
    if (!body.trim()) return text;
    // Never double-wrap: a file translated twice would otherwise accumulate
    // marks until some renderers give up.
    if (body.startsWith(RLE)) return text;
    return `${lead}${RLE}${body}${PDF}${trail}`;
  }

  const stripRtl = (s) => String(s || '').split(RLE).join('').split(PDF).join('');

  // ------------------------------------------------------------------ SRT

  function parseSrt(text) {
    const cues = [];
    const blocks = text.replace(/\r\n?/g, '\n').split(/\n{2,}/);
    for (const block of blocks) {
      const lines = block.split('\n').filter((l) => l.trim() !== '');
      if (!lines.length) continue;
      // The numeric index is optional in the wild — find the timing line.
      let timeIndex = lines.findIndex((l) => l.includes('-->'));
      if (timeIndex === -1) continue;
      const [rawStart, rawEnd] = lines[timeIndex].split('-->');
      const start = parseTime(rawStart);
      const end = parseTime(rawEnd);
      if (start == null || end == null) continue;
      cues.push({
        id: String(cues.length + 1),
        start,
        end,
        text: lines.slice(timeIndex + 1).join('\n'),
      });
    }
    return cues;
  }

  function serializeSrt(cues) {
    return (
      cues
        .map((cue, i) =>
          `${i + 1}\n${formatTime(cue.start, 'srt')} --> ${formatTime(cue.end, 'srt')}\n${cue.text}`
        )
        .join('\n\n') + '\n'
    );
  }

  // ------------------------------------------------------------------ VTT

  function parseVtt(text) {
    const cues = [];
    const body = text.replace(/\r\n?/g, '\n').replace(/^﻿/, '');
    for (const [blockIndex, block] of body.split(/\n{2,}/).entries()) {
      const lines = block.split('\n').filter((l) => l.trim() !== '');
      if (!lines.length) continue;
      // WEBVTT header, NOTE and STYLE blocks carry no cue.
      if (/^(NOTE|STYLE|REGION)\b/.test(lines[0])) continue;
      if (/^WEBVTT\b/.test(lines[0]) && !block.includes('-->')) continue;
      const timeIndex = lines.findIndex((l) => l.includes('-->'));
      if (timeIndex === -1) continue;
      const timeLine = lines[timeIndex];
      const arrow = timeLine.indexOf('-->');
      const start = parseTime(timeLine.slice(0, arrow));
      const rest = timeLine.slice(arrow + 3).trim();
      const endMatch = /^[\d:.]+/.exec(rest);
      const end = parseTime(endMatch ? endMatch[0] : '');
      if (start == null || end == null) continue;
      cues.push({
        id: timeIndex > 0 ? lines[timeIndex - 1] : String(cues.length + 1),
        blockIndex,
        sourcePrefix: lines.slice(0, timeIndex + 1).join('\n'),
        start,
        end,
        // Cue settings (align, position, line…) live after the end time and
        // are positioning, not text — carried through untouched.
        settings: endMatch ? rest.slice(endMatch[0].length).trim() : '',
        text: lines.slice(timeIndex + 1).join('\n'),
      });
    }
    return cues;
  }

  function serializeVtt(cues, sourceBlocks) {
    if (sourceBlocks) {
      const blocks = sourceBlocks.slice();
      for (const cue of cues) {
        if (cue.blockIndex != null && cue.sourcePrefix) blocks[cue.blockIndex] = `${cue.sourcePrefix}\n${cue.text}`;
      }
      return blocks.join('\n\n');
    }
    const body = cues
      .map(
        (cue) =>
          `${cue.id ? `${cue.id}\n` : ''}${formatTime(cue.start, 'vtt')} --> ${formatTime(cue.end, 'vtt')}` +
          `${cue.settings ? ` ${cue.settings}` : ''}\n${cue.text}`
      )
      .join('\n\n');
    return `WEBVTT\n\n${body}\n`;
  }

  // ------------------------------------------------------------- ASS/SSA

  /**
   * ASS is line-oriented and section-based. Only `[Events]` Dialogue lines
   * carry translatable text; everything else — script info, styles, fonts,
   * graphics — is copied through byte for byte, so a round trip through this
   * engine cannot damage a subtitle's styling.
   */
  function parseAss(text) {
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const cues = [];
    // `Format:` names the field order, and the Text field is last by spec —
    // but it is the ONLY field allowed to contain commas, so the split must be
    // bounded by the field count rather than greedy.
    let fields = ['Layer', 'Start', 'End', 'Style', 'Name', 'MarginL', 'MarginR', 'MarginV', 'Effect', 'Text'];
    let inEvents = false;
    lines.forEach((line, lineIndex) => {
      const section = /^\s*\[(.+)\]\s*$/.exec(line);
      if (section) {
        inEvents = /^events$/i.test(section[1].trim());
        return;
      }
      if (!inEvents) return;
      if (/^\s*Format\s*:/i.test(line)) {
        fields = line.slice(line.indexOf(':') + 1).split(',').map((f) => f.trim());
        return;
      }
      const kind = /^\s*(Dialogue|Comment)\s*:/i.exec(line);
      if (!kind) return;
      // Drop the single space ASS writes after the colon, so re-serializing an
      // untouched line reproduces it exactly rather than growing a space.
      const rest = line.slice(line.indexOf(':') + 1).replace(/^[ \t]/, '');
      const parts = [];
      let cursor = 0;
      for (let i = 0; i < fields.length - 1; i += 1) {
        const comma = rest.indexOf(',', cursor);
        if (comma === -1) return; // malformed line: leave it untouched
        parts.push(rest.slice(cursor, comma));
        cursor = comma + 1;
      }
      parts.push(rest.slice(cursor));
      const map = {};
      fields.forEach((name, i) => { map[name] = parts[i]; });
      const start = parseTime(map.Start);
      const end = parseTime(map.End);
      if (start == null || end == null) return;
      cues.push({
        id: String(cues.length + 1),
        start,
        end,
        text: map.Text ?? '',
        lineIndex,
        kind: kind[1],
        style: (map.Style || '').trim(),
        actor: (map.Name || '').trim(),
        fields: map,
        fieldOrder: fields,
      });
    });
    return { cues, lines };
  }

  /**
   * Rebuild the file, rewriting ONLY the event lines whose text actually
   * changed. Everything else — comments, karaoke, drawings, and any line the
   * translator skipped — is passed through as the original string, so a round
   * trip through this engine is byte-identical for untouched content. That is
   * a stronger guarantee than "re-serialize everything identically", and it
   * cannot rot as the serializer changes.
   */
  function serializeAss(sourceLines, cues) {
    const out = sourceLines.slice();
    for (const cue of cues) {
      if (cue.lineIndex == null || !cue.dirty) continue;
      const fields = { ...cue.fields, Text: cue.text, Start: formatTime(cue.start, 'ass'), End: formatTime(cue.end, 'ass') };
      const values = cue.fieldOrder.map((name) => fields[name] ?? '');
      out[cue.lineIndex] = `${cue.kind}: ${values.join(',')}`;
    }
    return out.join('\n');
  }

  /**
   * Change only requested ASS style fields. A font name does not embed the
   * font; rendering still requires that font and a capable subtitle renderer.
   */
  function patchAssStyles(sourceLines, fontName, options = {}) {
    // ASS style values are comma-separated. A font name is never syntax.
    const font = String(fontName || '').trim().replace(/[,\r\n\u0000-\u001f]/g, '').slice(0,160);
    const fields = {};
    if (font) { fields.fontname = font; fields.encoding = '1'; }
    if (typeof options.fontSize === 'number' && options.fontSize >= 8 && options.fontSize <= 144) fields.fontsize = String(options.fontSize);
    if (typeof options.outline === 'number' && options.outline >= 0 && options.outline <= 8) fields.outline = String(options.outline);
    if (Number.isInteger(options.alignment) && options.alignment >= 1 && options.alignment <= 9) fields.alignment = String(options.alignment);
    if (!Object.keys(fields).length) return sourceLines;
    let inStyles = false;
    let legacyStyles = false;
    let order = null;
    return sourceLines.map((line) => {
      const section = /^\s*\[(.+)\]\s*$/.exec(line);
      if (section) {
        inStyles = /^v4\+? styles$/i.test(section[1].trim()) || /^v4 styles$/i.test(section[1].trim());
        legacyStyles = /^v4 styles$/i.test(section[1].trim());
        order = null;
        return line;
      }
      if (!inStyles) return line;
      if (/^\s*Format\s*:/i.test(line)) {
        order = line.slice(line.indexOf(':') + 1).split(',').map((f) => f.trim());
        return line;
      }
      if (!/^\s*Style\s*:/i.test(line) || !order) return line;
      const values = line.slice(line.indexOf(':') + 1).split(',');
      for (const [name,value] of Object.entries(fields)) {
        const at = order.findIndex(f => f.toLowerCase() === name);
        if (at >= 0 && at < values.length) values[at] = name === 'alignment' && legacyStyles
          ? String({1:1,2:2,3:3,4:9,5:10,6:11,7:5,8:6,9:7}[Number(value)]) : value;
      }
      return `Style: ${values.join(',').replace(/^\s*/, '')}`;
    });
  }

  // ------------------------------------------------------------ detection

  function detectFormat(text, filename = '') {
    if (/\[Script Info\]|\[V4\+? Styles\]|^\s*Dialogue\s*:/im.test(text)) return 'ass';
    if (/^﻿?WEBVTT/.test(text)) return 'vtt';
    if (/\.vtt$/i.test(filename)) return 'vtt';
    if (/\.(ass|ssa)$/i.test(filename)) return 'ass';
    return 'srt';
  }

  // ------------------------------------------------------------ public API

  /**
   * Parse a subtitle file into a document that can be rebuilt with
   * translations applied.
   *
   * @param {string} text  already decoded (see decodeBytes)
   * @param {string} [filename] used only as a hint when the content is ambiguous
   */
  function parse(text, filename = '') {
    const format = detectFormat(text, filename);
    if (format === 'ass') {
      const { cues, lines } = parseAss(text);
      return { format, cues, sourceLines: lines };
    }
    if (format === 'vtt') return { format, cues: parseVtt(text), sourceBlocks: text.replace(/\r\n?/g, '\n').replace(/^﻿/, '').split(/\n{2,}/) };
    return { format, cues: parseSrt(text) };
  }

  /**
   * The units that should actually be sent to the translator.
   *
   * Skipped, each for a concrete reason:
   *  - `Comment:` lines are the author's notes, not shown to anyone.
   *  - Vector drawings (`{\p1}…`) are coordinate lists; "translating" one
   *    corrupts the artwork.
   *  - Karaoke (`\k`) splits a line into per-syllable timed fragments that no
   *    translation can preserve; translating it destroys the timing silently,
   *    so it is left alone and reported instead.
   *  - Lines with no letters at all (♪, ---, numbers) have nothing to translate.
   *
   * @returns {{items: Array<{index:number, plain:string, tokens:string[]}>, skipped: object}}
   */
  function collectTranslatable(doc) {
    const items = [];
    const skipped = { comment: 0, drawing: 0, karaoke: 0, empty: 0, timing: 0 };
    doc.cues.forEach((cue, index) => {
      if (/^comment$/i.test(cue.kind || '')) { skipped.comment += 1; return; }
      const raw = String(cue.text || '');
      if (/\\p[1-9]/.test(raw)) { skipped.drawing += 1; return; }
      if (/\\(?:k|kf|ko|K)\d/.test(raw)) { skipped.karaoke += 1; return; }
      // Files routinely contain editor markers with equal start/end times.
      // Their non-display interval must not reject the whole document or be
      // invented into spoken time. Keep their original event in the export.
      if (!Number.isSafeInteger(cue.start) || !Number.isSafeInteger(cue.end) || cue.start < 0 || cue.end <= cue.start) {
        skipped.timing += 1; return;
      }
      const { plain, tokens } = tokenize(raw);
      // For SRT/VTT the cue's own newlines are cosmetic wrapping: joining them
      // lets the model translate a whole sentence instead of two fragments.
      const joined = doc.format === 'ass' ? plain : plain.replace(/\s*\n\s*/g, ' ');
      if (!isTranslatable(joined)) { skipped.empty += 1; return; }
      items.push({ index, plain: joined.trim(), tokens });
    });
    return { items, skipped };
  }

  /**
   * Apply translations and rebuild the file.
   *
   * @param {object} doc              from parse()
   * @param {Array} items             from collectTranslatable()
   * @param {Array<string|null>} out  translation per item; null keeps the original
   * @param {{rtl?:boolean, rewrap?:boolean, width?:number, maxLines?:number,
   *          bilingual?:boolean, font?:string}} opts
   * @returns {{text: string, translated: number, kept: number}}
   */
  function build(doc, items, out, opts = {}) {
    const {
      rtl = true,
      rewrap = true,
      width = 42,
      maxLines = 2,
      bilingual = false,
      font = '',
    } = opts;
    const cues = doc.cues.map((cue) => ({ ...cue }));
    let translated = 0;
    let kept = 0;

    items.forEach((item, i) => {
      const value = out[i];
      if (typeof value !== 'string' || !value.trim() || !validTokens(value, item.tokens)) { kept += 1; return; }
      translated += 1;
      const restored = detokenize(value.trim(), item.tokens);
      const cue = cues[item.index];

      if (doc.format === 'ass') {
        const segments = restored.split(/\\N/);
        const lines = segments.map((s) => (rtl ? rtlWrap(s) : s));
        let text = lines.join('\\N');
        if (bilingual) {
          // Original underneath, dimmed one size down — readable without
          // competing with the translation.
          text += `\\N{\\fscx70\\fscy70\\alpha&H60&}${stripRtl(String(cue.text || '')).replace(/\\N/g, ' ')}`;
        }
        cue.text = text;
        cue.dirty = true;
        return;
      }

      // SRT / VTT
      const body = restored.replace(/\\N/g, '\n');
      const displayLines = rewrap
        ? body.split('\n').flatMap((line) => wrapLine(line, width, maxLines))
        : body.split('\n');
      const finalLines = rtl ? displayLines.map(rtlWrap) : displayLines;
      cue.text = finalLines.join('\n');
      if (bilingual) cue.text += `\n${stripRtl(String(doc.cues[item.index].text || ''))}`;
    });

    let text;
    if (doc.format === 'ass') {
      const lines = patchAssStyles(doc.sourceLines, font, opts);
      text = serializeAss(lines, cues);
    } else if (doc.format === 'vtt') {
      text = serializeVtt(cues, doc.sourceBlocks);
    } else {
      text = serializeSrt(cues);
    }
    return { text, translated, kept };
  }

  /**
   * Group cues into dubbing segments.
   *
   * A subtitle cue is a READING unit, not a speaking one: fansubs routinely
   * break one sentence across three cues. Dubbing those separately produces a
   * voice that inhales every two seconds. Consecutive cues are therefore
   * merged while the gap is small AND the previous cue does not end a
   * sentence — the same rule the YouTube pipeline uses, applied to files.
   *
   * @returns {Array<{start:number, end:number, text:string, cues:number[]}>}
   */
  function toSpeechSegments(translatedCues, { maxGapMs = 400, maxChars = 300 } = {}) {
    const SENT_END = /[.!?؟…؛۔:]\s*$/;
    const segments = [];
    // Preserve source indexes for callers, while ordering only the speech copy.
    // ASS editors commonly group events by layer rather than by time.
    const ordered = translatedCues.map((cue, index) => ({ cue, index })).filter(({ cue }) =>
      Number.isSafeInteger(cue.start) && Number.isSafeInteger(cue.end) && cue.start >= 0 && cue.end > cue.start &&
      !/^comment$/i.test(cue.kind || '') && !/\\p[1-9]/.test(cue.text || '')
    ).sort((a, b) => a.cue.start - b.cue.start || a.index - b.index);
    let previousActor;
    ordered.forEach(({ cue, index }) => {
      const plain = stripRtl(String(cue.text || ''))
        .replace(/\{[^}]*\}/g, '')
        .replace(/\\[Nnh]/g, ' ')
        .replace(/<\/?[a-zA-Z][^>]*>/g, '')
        .replace(/<(?:\d+:)?\d{2}:\d{2}\.\d{3}>/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (!plain) return;
      const previous = segments[segments.length - 1];
      const continues =
        previous &&
        maxGapMs >= 0 &&
        cue.start >= previous.end &&
        cue.start - previous.end <= maxGapMs &&
        (cue.actor || '') === previousActor &&
        !SENT_END.test(previous.text) &&
        previous.text.length + plain.length <= maxChars;
      if (continues) {
        previous.text += ` ${plain}`;
        previous.end = cue.end;
        previous.cues.push(index);
      } else {
        segments.push({ start: cue.start, end: cue.end, text: plain, cues: [index] });
      }
      previousActor = cue.actor || '';
    });
    return segments;
  }

  globalThis.GXT.subs = {
    RLE,
    PDF,
    decodeBytes,
    detectFormat,
    parse,
    collectTranslatable,
    build,
    validTokens,
    toSpeechSegments,
    _internal: {
      parseTime,
      formatTime,
      tokenize,
      detokenize,
      wrapLine,
      rtlWrap,
      stripRtl,
      isTranslatable,
      parseSrt,
      parseVtt,
      parseAss,
      serializeSrt,
      serializeVtt,
      serializeAss,
      patchAssStyles,
    },
  };
})();
