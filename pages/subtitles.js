/**
 * Subtitle workbench (v2.3.0).
 *
 * A normal extension page, so it has the extension's own origin and CSP: no
 * host permissions to negotiate, no page CSP to work around, and files never
 * leave the machine except as the text sent to the translation provider the
 * user already chose.
 *
 * Two products from one file:
 *   1. a Persian subtitle file, formatting and timing intact;
 *   2. a Persian DUB TRACK — a single audio file, silent except where someone
 *      speaks, aligned to the original timeline, so `mpv --audio-file=` plays
 *      it over the video.
 *
 * The dub is where the interesting engineering is. Translated Persian runs
 * 15–30% longer than English, so a naive "synthesize each line and drop it at
 * its timestamp" drifts into the next line within a minute. See fitSegment().
 */
'use strict';
(() => {
  const GXTS = globalThis.GXT;
  const S = globalThis.GXT.subs;
  const W = globalThis.GXT.workshop;
  const $ = (id) => document.getElementById(id);

  const DUB_RATE = 24000; // Hz — matches what every engine here returns

  let doc = null;          // parsed document
  let sourceName = '';
  let translatable = null; // { items, skipped }
  let output = null;       // { text, translated, kept }
  let outputCues = null;   // cues after translation, for the dub
  let job = 0;             // generation counter — bumping it cancels everything
  let dubBlobUrl = '';
  let currentSettings = null;
  let project = null, session = null, editorPage = 0;
  const selection = new Set();
  let saveTimer = null, previewTimer = null, saveQueue = Promise.resolve(), dbPromise = null;
  let focusedEdit = '', editGrouped = false;
  let modelLists = { gemini: [], openai: [] }, modelListRevision = 0;
  const PAGE_SIZE = 30;
  let themeRevision = 0;
  const MAX_FILE_BYTES = 32 * 1024 * 1024;
  const MAX_DUB_SAMPLES = DUB_RATE * 60 * 200;

  const operationSettings = (settings) => JSON.stringify([
    settings.enabled, GXTS.cacheNamespace(GXTS.forScope(settings,'file')), settings.modelTuning,
    GXTS.resolveTts(settings), settings.openaiBaseUrl,
    settings.bridgeEnabled, settings.bridgePort, settings.bridgeToken,
  ]);

  const send = (message) => chrome.runtime.sendMessage(message).catch((error) => ({
    ok: false,
    code: 'PORT',
    error: String(error?.message || error),
  }));

  const faNum = (n) => globalThis.GXT.i18n ? globalThis.GXT.i18n.number(n) : Number(n || 0).toLocaleString('fa-IR');

  // ------------------------------------------------------------ appearance

  async function applyTheme(known) {
    const revision = ++themeRevision;
    const settings = known || await GXTS.getSettings();
    if (revision !== themeRevision) return;
    currentSettings = settings;
    GXTS.i18n.configure(settings);GXTS.i18n.apply(document);
    GXTS.theme.apply(document.documentElement, settings);
    syncTranslationControls();
    return settings;
  }

  const translationDefaults = () => ({ provider: 'inherit', model: '', temperature: null, thinking: 'auto', thinkingBudget: null, customPrompt: '' });
  const optionalNumber = id => $(id).value.trim() && $(id).validity.valid ? Number($(id).value) : null;
  function readTranslation() {
    if (!project) return;
    const { provider, model } = effectiveTranslation();
    const budgetModel = provider === 'gemini' && /^gemini-2\.5(?:-|$)/i.test(model);
    project.translation = { ...(GXTS.validTarget($('workshopTargetLang').value) ? {targetLang:$('workshopTargetLang').value} : {}), provider: $('workshopProvider').value, model: $('workshopModel').value.trim(),
      temperature: optionalNumber('workshopTemperature'), thinking: budgetModel ? 'auto' : $('workshopThinking').value,
      thinkingBudget: budgetModel ? optionalNumber('workshopThinkingBudget') : null, customPrompt: $('workshopCustomPrompt').value.trim().slice(0, 6000) };
  }
  function writeTranslation() {
    const value = { ...translationDefaults(), ...project?.translation };
    $('workshopTargetLang').value = value.targetLang || 'inherit';
    $('workshopProvider').value = value.provider; $('workshopModel').value = value.model;
    $('workshopTemperature').value = value.temperature ?? ''; $('workshopThinking').value = value.thinking;
    $('workshopThinkingBudget').value = value.thinkingBudget ?? ''; $('workshopCustomPrompt').value = value.customPrompt;
    syncTranslationControls();
  }
  function effectiveTranslation() {
    const provider = $('workshopProvider').value === 'inherit' ? (currentSettings?.provider || 'gemini') : $('workshopProvider').value;
    const model = $('workshopModel').value.trim() || (provider === 'openai' ? currentSettings?.openaiModel : currentSettings?.model) || '';
    return { provider, model, ai: ['gemini', 'openai'].includes(provider) };
  }
  function populateWorkshopModels(provider) {
    const values = new Map();
    if (provider === 'gemini') for (const item of GXTS.CURATED_MODELS || []) values.set(item.id, item.id);
    for (const item of modelLists[provider] || []) {
      const id = typeof item === 'string' ? item : item.id;
      if (id) values.set(id, item.displayName ? `${id} — ${item.displayName}` : id);
    }
    $('workshopModelList').replaceChildren(...[...values].map(([value, label]) => {
      const option = document.createElement('option'); option.value = value; option.label = label; return option;
    }));
  }
  function syncTranslationControls() {
    const { provider, model, ai } = effectiveTranslation();
    const label = { gemini: 'Gemini', get openai() { return globalThis.GXT.i18n.t("pages_subtitles_label_1"); }, google: 'Google Translate', bing: 'Bing' };
    const is25 = provider === 'gemini' && /^gemini-2\.5(?:-|$)/i.test(model);
    const is3 = provider === 'gemini' && /^gemini-3(?:[.\-]|$)/i.test(model);
    globalThis.GXT.i18n.bind($('engineTag'), "textContent", () => (globalThis.GXT.i18n.t("pages_subtitles_syncTranslationControls_13", {v0:(label[provider] || provider)})));
    $('workshopModel').disabled = !ai; $('workshopTemperature').disabled = !ai;
    $('refreshWorkshopModels').disabled = !ai;
    $('workshopCustomPrompt').disabled = !ai;
    for (const id of ['glossary','characters','workshopStyle','workshopInstructions']) $(id).disabled = !ai;
    show('workshopThinkingField', ai && !is25); show('workshopBudgetField', is25);
    $('workshopThinkingBudget').disabled = !is25;
    $('workshopThinking').disabled = !ai || is25;
    const noMinimal = is3 && (/pro/i.test(model) || /^gemini-3\.(?:[7-9]|\d{2,})-flash/i.test(model));
    for (const option of $('workshopThinking').options) option.disabled = (option.value === 'off' && is3) || (option.value === 'minimal' && noMinimal);
    globalThis.GXT.i18n.bind($('workshopModelHint'), "textContent", () => (ai
      ? globalThis.GXT.i18n.t("pages_subtitles_syncTranslationControls_11", {v0:(model || globalThis.GXT.i18n.t("pages_subtitles_syncTranslationControls_12"))})
      : globalThis.GXT.i18n.t("pages_subtitles_syncTranslationControls_10")));
    globalThis.GXT.i18n.bind($('contextNote'), "textContent", () => (ai
      ? globalThis.GXT.i18n.t("pages_subtitles_syncTranslationControls_9")
      : globalThis.GXT.i18n.t("pages_subtitles_syncTranslationControls_8")));
    globalThis.GXT.i18n.bind($('temperatureHint'), "textContent", () => (is3
      ? globalThis.GXT.i18n.t("pages_subtitles_syncTranslationControls_7")
      : globalThis.GXT.i18n.t("pages_subtitles_syncTranslationControls_6")));
    globalThis.GXT.i18n.bind($('thinkingHint'), "textContent", () => (provider === 'openai'
      ? globalThis.GXT.i18n.t("pages_subtitles_syncTranslationControls_5")
      : globalThis.GXT.i18n.t("pages_subtitles_syncTranslationControls_4")));
    $('workshopThinkingBudget').min = '-1';
    $('workshopThinkingBudget').max = /pro/i.test(model) ? '32768' : '24576';
    globalThis.GXT.i18n.bind($('thinkingBudgetHint'), "textContent", () => (/pro/i.test(model)
      ? globalThis.GXT.i18n.t("pages_subtitles_syncTranslationControls_3")
      : /lite/i.test(model) ? globalThis.GXT.i18n.t("pages_subtitles_syncTranslationControls_2")
      : globalThis.GXT.i18n.t("pages_subtitles_syncTranslationControls_1")));
    populateWorkshopModels(provider);
  }
  function translationChanged() {
    if (!project) return;
    if (session?.active) { resetJobs(); showError(globalThis.GXT.i18n.t("pages_subtitles_translationChanged_1")); }
    readTranslation(); project.revision++; syncTranslationControls(); renderEditor(); scheduleSave();
  }
  async function refreshWorkshopModels() {
    const provider = effectiveTranslation().provider;
    if (!['gemini','openai'].includes(provider)) return;
    const revision = ++modelListRevision;
    $('refreshWorkshopModels').disabled = true; globalThis.GXT.i18n.bind($('workshopModelHint'), "textContent", () => (globalThis.GXT.i18n.t("pages_subtitles_refreshWorkshopModels_4")));
    const result = await send({ type: 'LIST_MODELS', provider });
    if (revision !== modelListRevision || effectiveTranslation().provider !== provider) return;
    syncTranslationControls();
    if (!result?.ok) { globalThis.GXT.i18n.bind($('workshopModelHint'), "textContent", () => (globalThis.GXT.i18n.t("pages_subtitles_refreshWorkshopModels_2", {v0:(result?.error || globalThis.GXT.i18n.t("pages_subtitles_refreshWorkshopModels_3"))}))); return; }
    modelLists[provider] = result.groups?.text || (provider === 'gemini' ? GXTS.classifyModels(result.models || []).text : result.models || []);
    populateWorkshopModels(provider);
    globalThis.GXT.i18n.bind($('workshopModelHint'), "textContent", () => (globalThis.GXT.i18n.t("pages_subtitles_refreshWorkshopModels_1", {v0:(faNum(modelLists[provider].length))})));
  }

  function setupFontPreview() {
    const style = document.createElement('style');
    style.textContent = (GXTS.BUNDLED_FONTS || []).map(font => `@font-face{font-family:"${font.id}";src:url("${chrome.runtime.getURL(`fonts/${font.id}-Regular.woff2`)}") format("woff2");font-weight:400;font-display:swap;}`).join('\n');
    document.head.appendChild(style);
  }
  function syncOutputControls() {
    const isAss = doc?.format === 'ass';
    show('optFontRow', isAss); show('fontField');
    for (const id of ['outputFontSize','outputOutline','outputAlignment','resetOutputStyleBtn']) $(id).disabled = !isAss;
    globalThis.GXT.i18n.bind($('fontFormatHint'), "textContent", () => (isAss
      ? globalThis.GXT.i18n.t("pages_subtitles_syncOutputControls_2")
      : globalThis.GXT.i18n.t("pages_subtitles_syncOutputControls_1")));
    const name = $('fontName').value.trim();
    $('fontPreset').value = [...$('fontPreset').options].some(o => o.value === name) ? name : 'custom';
    const preview = $('outputFontPreview');
    preview.style.fontFamily = `${JSON.stringify(name || 'Vazirmatn')}, Tahoma, sans-serif`;
    preview.style.fontSize = `${Math.min(48, Math.max(16, optionalNumber('outputFontSize') || 26))}px`;
    const outline = optionalNumber('outputOutline') ?? 1;
    preview.style.webkitTextStroke = `${Math.min(3, outline)}px #070b10`;
    preview.style.paintOrder = 'stroke fill';
    const alignment = optionalNumber('outputAlignment') || 2;
    preview.style.textAlign = [1,4,7].includes(alignment) ? 'left' : [3,6,9].includes(alignment) ? 'right' : 'center';
    const stage = preview.parentElement;
    stage.style.alignItems = alignment >= 7 ? 'start' : alignment >= 4 ? 'center' : 'end';
    stage.style.justifyContent = [1,4,7].includes(alignment) ? 'end' : [3,6,9].includes(alignment) ? 'start' : 'center';
  }
  function writeOutputOptions(value = {}) {
    for (const [key,id,fallback] of [['rtl','optRtl',true],['rewrap','optRewrap',true],['bilingual','optBilingual',false]]) $(id).checked = typeof value[key] === 'boolean' ? value[key] : fallback;
    $('optFont').checked = typeof value.fontEnabled === 'boolean' ? value.fontEnabled : value.font !== '';
    $('fontName').value = typeof value.previewFont === 'string' ? value.previewFont.slice(0,120) : (value.font || 'Vazirmatn').slice(0,120);
    for (const [key,id] of [['fontSize','outputFontSize'],['outline','outputOutline'],['alignment','outputAlignment']]) $(id).value = value[key] ?? '';
    syncOutputControls();
  }

  // ----------------------------------------------------------- file intake

  function show(id, on = true) { $(id).classList.toggle('hidden', !on); }

  function fact(label, value, kind = '') {
    return `<div class="fact${kind ? ` ${kind}` : ''}"><span>${label}</span><b>${value}</b></div>`;
  }

  function resetJobs() {
    session?.cancel();
    job += 1;
    $('translateBtn').disabled = false;
    $('resumeBtn').disabled = false;
    $('cancelBtn').disabled = true;
    $('dubBtn').disabled = false;
    $('dubCancelBtn').disabled = true;
    for (const id of ['progress', 'dubProgress']) show(id, false);
    $('progressFill').style.width = '0%';
    $('dubFill').style.width = '0%';
    $('progressText').textContent = '';
    $('dubText').textContent = '';
    return job;
  }

  function clearDub() {
    $('dubPreview').pause();
    $('dubPreview').removeAttribute('src');
    $('dubPreview').load();
    if (dubBlobUrl) { URL.revokeObjectURL(dubBlobUrl); dubBlobUrl = ''; }
    show('dubDownloadRow', false);
  }

  async function loadFile(file) {
    flushSave();
    const myJob = resetJobs();
    clearTimeout(previewTimer);
    project = null; session = null; selection.clear(); editorPage = 0;
    doc = null; translatable = null; output = null; outputCues = null;
    sourceName = '';
    clearDub();
    for (const id of ['fileCard', 'optionsCard', 'editorCard', 'resultCard', 'dubCard', 'errorNote']) show(id, false);
    let parsed, encoding;
    try {
      if (file.size > MAX_FILE_BYTES) throw new Error(globalThis.GXT.i18n.t("pages_subtitles_loadFile_14"));
      const buffer = await file.arrayBuffer();
      if (job !== myJob) return;
      const decoded = S.decodeBytes(buffer);
      encoding = decoded.encoding;
      parsed = S.parse(decoded.text, file.name);
      if (parsed.cues.some(cue => !Number.isSafeInteger(cue.start) || !Number.isSafeInteger(cue.end) || cue.start < 0 || cue.end < 0)) {
        throw new Error(globalThis.GXT.i18n.t("pages_subtitles_loadFile_13"));
      }
    } catch (error) {
      if (job === myJob) showError(globalThis.GXT.i18n.t("pages_subtitles_loadFile_12", {v0:(String(error?.message || error))}));
      return;
    }
    if (!parsed.cues.length) {
      showError(globalThis.GXT.i18n.t("pages_subtitles_loadFile_11"));
      return;
    }
    doc = parsed;
    sourceName = file.name;
    translatable = S.collectTranslatable(doc);
    project = W.createProject(doc, sourceName);
    session = new W.Session(project);
    writeRules(); writeTranslation(); writeOutputOptions();
    renderEditor();
    scheduleSave();
    output = null;
    outputCues = null;

    const duration = doc.cues.reduce((last, cue) => Math.max(last, cue.end), 0);
    const formatName = { srt: 'SubRip (SRT)', ass: 'Advanced SubStation (ASS)', vtt: 'WebVTT' };
    $('fileName').textContent = file.name;
    globalThis.GXT.i18n.bind($('facts'), "innerHTML", () => (fact(globalThis.GXT.i18n.t("pages_subtitles_openSnapshot_4"), formatName[doc.format] || doc.format) +
      fact(globalThis.GXT.i18n.t("pages_subtitles_loadFile_10"), encoding, encoding === 'windows-1256' ? 'warn' : '') +
      fact(globalThis.GXT.i18n.t("pages_subtitles_openSnapshot_3"), faNum(doc.cues.length)) +
      fact(globalThis.GXT.i18n.t("pages_subtitles_loadFile_9"), faNum(translatable.items.length)) +
      fact(globalThis.GXT.i18n.t("pages_subtitles_loadFile_8"), S._internal.formatTime(duration, 'srt').split(',')[0])));

    // Skipped lines are reported, never silently dropped: a user who sees
    // "۱۲ خط کارائوکه" understands the output; one who doesn't just sees gaps.
    const reasons = [];
    const sk = translatable.skipped;
    if (sk.karaoke) reasons.push(globalThis.GXT.i18n.t("pages_subtitles_loadFile_7", {v0:(faNum(sk.karaoke))}));
    if (sk.drawing) reasons.push(globalThis.GXT.i18n.t("pages_subtitles_loadFile_6", {v0:(faNum(sk.drawing))}));
    if (sk.comment) reasons.push(globalThis.GXT.i18n.t("pages_subtitles_loadFile_5", {v0:(faNum(sk.comment))}));
    if (sk.empty) reasons.push(globalThis.GXT.i18n.t("pages_subtitles_loadFile_4", {v0:(faNum(sk.empty))}));
    if (sk.timing) reasons.push(globalThis.GXT.i18n.t("pages_subtitles_loadFile_3", {v0:(faNum(sk.timing))}));
    show('skipNote', reasons.length > 0);
    if (reasons.length) {
      globalThis.GXT.i18n.bind($('skipNote'), "innerHTML", () => (globalThis.GXT.i18n.t("pages_subtitles_loadFile_2", {v0:(reasons.join(' · '))})));
    }

    $('preview').innerHTML = doc.cues
      .slice(0, 12)
      .map((cue) => `<div class="pv"><span class="pv-t">${S._internal.formatTime(cue.start, 'srt')}</span>` +
        `<span class="pv-x">${escapeHtml(cue.text).replace(/\n/g, '<br>')}</span></div>`)
      .join('');

    show('fileCard');
    show('optionsCard');
    show('editorCard');
    syncOutputControls();
    show('optRewrapRow', doc.format !== 'ass');
    show('resultCard', false);
    show('dubCard', false);
    show('errorNote', false);
    // Hiding the old result is not enough — clear it, so a new file can never
    // briefly show the previous file's translation or play its dub.
    $('resultPreview').textContent = '';
    $('resultFacts').innerHTML = '';
    $('dubPreview').removeAttribute('src');
    show('dubDownloadRow', false);
    show('dubNote', false);
    if (dubBlobUrl) { URL.revokeObjectURL(dubBlobUrl); dubBlobUrl = ''; }

    // A file that is ALREADY Persian needs no translation — offer the dub
    // straight away. Plenty of anime already has a Persian sub floating around.
    if (looksPersian(doc)) {
      outputCues = doc.cues.map((c) => ({ ...c }));
      show('dubCard');
      $('dubNote').className = 'notice';
      globalThis.GXT.i18n.bind($('dubNote'), "textContent", () => (globalThis.GXT.i18n.t("pages_subtitles_loadFile_1")));
      show('dubNote');
    }
  }

  /** Persian-only letters: چ پ ژ گ ی and the ZWNJ. Arabic text will not match. */
  const PERSIAN_RE = /[پچژگی‌]/;

  function looksPersian(document_) {
    const sample = document_.cues.slice(0, 60).map((c) => c.text).join(' ');
    const persian = (sample.match(/[؀-ۿ]/g) || []).length;
    const latin = (sample.match(/[A-Za-z]/g) || []).length;
    return PERSIAN_RE.test(sample) && persian > latin;
  }

  const escapeHtml = (s) =>
    String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function showError(message) {
    $('errorNote').textContent = message;
    show('errorNote');
  }

  // ------------------------------------------------------------ translate

  function outputOptions() {
    return { rtl: GXTS.targetDirection(project?.translation?.targetLang || GXTS.forScope(currentSettings,'file').targetLang) === 'rtl' && $('optRtl').checked, rewrap: $('optRewrap').checked, bilingual: $('optBilingual').checked,
      font: doc?.format === 'ass' && $('optFont').checked ? $('fontName').value.trim() : '',
      fontEnabled: $('optFont').checked, previewFont: $('fontName').value.trim(),
      fontSize: optionalNumber('outputFontSize'), outline: optionalNumber('outputOutline'), alignment: optionalNumber('outputAlignment') };
  }

  async function translate({ ids = null, force = false } = {}) {
    if (!$('workshopTargetLang').reportValidity()) return;
    if (!doc || !project) return;
    for (const id of ['workshopTemperature','workshopThinkingBudget','outputFontSize','outputOutline']) {
      if (!$(id).disabled && !$(id).reportValidity()) return;
    }
    if (!$('workshopThinking').disabled && $('workshopThinking').selectedOptions[0]?.disabled) {
      showError(globalThis.GXT.i18n.t("pages_subtitles_translate_2"));
      $('modelAdvanced').open = true; $('workshopThinking').focus(); return;
    }
    const myJob = resetJobs(), activeProject = project, activeSession = session;
    clearDub(); output = null; outputCues = null;
    show('errorNote', false); $('errorNote').textContent = '';
    show('progress'); show('resultCard', false); show('dubCard', false);
    $('translateBtn').disabled = true; $('resumeBtn').disabled = true; $('cancelBtn').disabled = false;
    readRules(); readTranslation();
    const signature = W.hash(JSON.stringify([operationSettings(currentSettings || {}), activeProject.translation, activeProject.rules]));
    // Existing completed output remains reviewable after an engine change. A
    // full translate explicitly recomputes unlocked rows; resume fills holes.
    activeProject.signature = signature;
    try {
      const result = await activeSession.run(send, { ids, force,
        cancel: requestId => void send({ type: 'CANCEL_WORKSHOP', requestId }),
        onUpdate: progress => {
          if (job !== myJob || project !== activeProject) return;
          const pct = progress.total ? Math.round(progress.done / progress.total * 100) : 100;
          $('progressFill').style.width = `${pct}%`;
          globalThis.GXT.i18n.bind($('progressText'), "textContent", () => (globalThis.GXT.i18n.t("pages_subtitles_result_3", {v0:(faNum(progress.done)), v1:(faNum(progress.total)), v2:(faNum(progress.chunk)), v3:(faNum(progress.chunks))}) +
            (progress.failed ? globalThis.GXT.i18n.t("pages_subtitles_result_2", {v0:(faNum(progress.failed))}) : '') + (progress.repaired ? globalThis.GXT.i18n.t("pages_subtitles_result_1", {v0:(faNum(progress.repaired))}) : '')));
          renderEditor(); scheduleSave();
        },
      });
      if (job !== myJob || project !== activeProject) return;
      refreshOutput();
      if (result.error || result.failed) showError(result.error || globalThis.GXT.i18n.t("pages_subtitles_translate_1", {v0:(faNum(result.failed))}));
    } catch (error) {
      if (job === myJob) showError(String(error?.message || error));
    } finally {
      if (job === myJob) { $('translateBtn').disabled = false; $('resumeBtn').disabled = false; $('cancelBtn').disabled = true; show('progress', false); renderEditor(); flushSave(); }
    }
  }

  function refreshOutput() {
    if (!project || !doc) return;
    const results = project.rows.map(row => row.translation), opts = outputOptions();
    output = S.build(doc, translatable.items, results, opts);
    outputCues = rebuildCues(translatable.items, results, opts);
    const invalid = project.rows.filter(row => row.translation && !S.validTokens(row.translation, row.tokens)).length;
    const suspicious = project.rows.filter(row => W.qa(row, project.rules).length).length;
    globalThis.GXT.i18n.bind($('resultFacts'), "innerHTML", () => (fact(globalThis.GXT.i18n.t("content_manga_actions_1"), faNum(output.translated)) +
      fact(globalThis.GXT.i18n.t("pages_subtitles_refreshOutput_3"), faNum(output.kept + doc.cues.length - project.rows.length), output.kept ? 'warn' : '') +
      fact(globalThis.GXT.i18n.t("pages_subtitles_refreshOutput_2"), faNum(suspicious), suspicious ? 'warn' : '') +
      (invalid ? fact(globalThis.GXT.i18n.t("pages_subtitles_refreshOutput_1"), faNum(invalid), 'warn') : '')));
    $('resultPreview').innerHTML = output.text.split('\n').slice(0, 24).map(line => `<div class="pv-line">${escapeHtml(line) || '&nbsp;'}</div>`).join('');
    show('resultCard'); show('dubCard');
  }

  const qaLabels = { get missing() { return globalThis.GXT.i18n.t("pages_subtitles_qaLabels_8"); }, get formatting() { return globalThis.GXT.i18n.t("pages_subtitles_qaLabels_7"); }, get 'reading-speed'() { return globalThis.GXT.i18n.t("pages_subtitles_qaLabels_6"); }, get 'line-length'() { return globalThis.GXT.i18n.t("pages_subtitles_qaLabels_5"); }, get 'line-count'() { return globalThis.GXT.i18n.t("pages_subtitles_qaLabels_4"); }, get timing() { return globalThis.GXT.i18n.t("pages_subtitles_qaLabels_3"); }, get unchanged() { return globalThis.GXT.i18n.t("pages_subtitles_qaLabels_2"); }, get glossary() { return globalThis.GXT.i18n.t("pages_subtitles_qaLabels_1"); }, get failed() { return globalThis.GXT.i18n.t("background_service_worker_message_5"); } };
  const statusLabels = { get pending() { return globalThis.GXT.i18n.t("content_youtube_label_9"); }, get ready() { return globalThis.GXT.i18n.t("content_manga_actions_1"); }, get manual() { return globalThis.GXT.i18n.t("pages_subtitles_wire_2"); }, get error() { return globalThis.GXT.i18n.t("pages_subtitles_statusLabels_1"); }, get translating() { return globalThis.GXT.i18n.t("content_page_translate_translateSelection_1"); } };
  function filteredRows() {
    if (!project) return [];
    const query = $('searchText').value.trim().toLocaleLowerCase();
    return project.rows.filter(row => (!query || `${row.text} ${row.translation || ''}`.toLocaleLowerCase().includes(query)) && (!$('onlyQa').checked || W.qa(row, project.rules).length));
  }
  function renderEditor() {
    if (!project) return;
    const rows = filteredRows(), pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    editorPage = Math.max(0, Math.min(editorPage, pages - 1));
    const visible = rows.slice(editorPage * PAGE_SIZE, (editorPage + 1) * PAGE_SIZE);
    const focused = document.activeElement;
    // A batch result must not replace a live textarea and move its caret.
    if (!focused?.matches('#editorRows textarea')) {
      const memoryIndex = W.memoryIndex(project);
      globalThis.GXT.i18n.bind($('editorRows'), "innerHTML", () => (visible.map(row => {
        const issues = W.qa(row, project.rules);
        const memory = W.suggestions(project, row, memoryIndex);
        return globalThis.GXT.i18n.t("pages_subtitles_renderEditor_5", {v0:(row.locked ? ' is-locked' : ''), v1:(row.id), v2:(selection.has(row.id) ? 'checked' : ''), v3:(faNum(row.index + 1)), v4:(S._internal.formatTime(row.start, 'srt')), v5:(S._internal.formatTime(row.end, 'srt')), v6:(escapeHtml(row.speaker || globalThis.GXT.i18n.t("pages_subtitles_renderEditor_6"))), v7:(statusLabels[row.status] || ''), v8:(escapeHtml(row.text)), v9:(row.index + 1), v10:(escapeHtml(row.translation || '')), v11:(row.locked ? 'checked' : ''), v12:(row.locked || session?.active ? 'disabled' : ''), v13:(memory.length ? globalThis.GXT.i18n.t("pages_subtitles_renderEditor_7") : ''), v14:(issues.map(code => qaLabels[code]).join(' · ')), v15:(row.error ? `<p class="cue-error">${escapeHtml(row.error)}</p>` : '')});
      }).join('') || globalThis.GXT.i18n.t("pages_subtitles_renderEditor_4")));
    }
    globalThis.GXT.i18n.bind($('pageLabel'), "textContent", () => (globalThis.GXT.i18n.t("pages_subtitles_renderEditor_3", {v0:(faNum(editorPage + 1)), v1:(faNum(pages)), v2:(faNum(rows.length))})));
    $('previousPage').disabled = editorPage === 0; $('nextPage').disabled = editorPage >= pages - 1;
    $('selectPage').checked = visible.length > 0 && visible.every(r => selection.has(r.id));
    globalThis.GXT.i18n.bind($('selectionCount'), "textContent", () => (globalThis.GXT.i18n.t("pages_subtitles_renderEditor_2", {v0:(faNum(selection.size))})));
    globalThis.GXT.i18n.bind($('editorSummary'), "textContent", () => (globalThis.GXT.i18n.t("pages_subtitles_renderEditor_1", {v0:(faNum(project.rows.filter(r => !!r.translation).length)), v1:(faNum(project.rows.length)), v2:(faNum(project.rows.filter(r => r.locked).length))})));
    $('undoBtn').disabled = !project.undo.length;
    $('retranslateSelectionBtn').disabled = !selection.size || session?.active;
  }
  function readRules() {
    if (!project) return;
    project.rules = { glossary: W.parseRules($('glossary').value), characters: W.parseRules($('characters').value),
      style: $('workshopStyle').value, instructions: $('workshopInstructions').value.trim().slice(0, 1500) };
  }
  function writeRules() {
    if (!project) return;
    const text = rules => rules.map(rule => `${rule.source} = ${rule.target}`).join('\n');
    $('glossary').value = text(project.rules.glossary); $('characters').value = text(project.rules.characters);
    $('workshopStyle').value = project.rules.style; $('workshopInstructions').value = project.rules.instructions;
  }
  function edited() {
    clearDub(); scheduleSave();
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => { refreshOutput(); renderEditor(); }, 300);
  }

  // Each project has its own key and previous snapshot. One transaction writes
  // both; a quota or crash cannot leave a half-written document. The per-page
  // queue preserves order and recovers after failure without touching settings.
  function database() {
    if (!dbPromise) dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open('gxt-subtitle-projects', 1);
      request.onupgradeneeded = () => { request.result.createObjectStore('projects', { keyPath: 'id' }); request.result.createObjectStore('previous', { keyPath: 'id' }); };
      request.onsuccess = () => { const db = request.result; db.onversionchange = () => { db.close(); dbPromise = null; }; resolve(db); };
      request.onerror = () => { dbPromise = null; reject(request.error); };
      request.onblocked = () => { dbPromise = null; reject(Error(globalThis.GXT.i18n.t("pages_subtitles_database_1"))); };
    });
    return dbPromise;
  }
  async function listProjects() {
    const db = await database();
    const list = await new Promise((resolve, reject) => {
      const items = [], tx = db.transaction('projects'), cursor = tx.objectStore('projects').openCursor();
      cursor.onsuccess = () => { const c = cursor.result; if (c) { items.push({ id: c.value.id, name: c.value.name, savedAt: c.value.savedAt }); c.continue(); } };
      tx.oncomplete = () => resolve(items); tx.onerror = () => reject(tx.error);
    });
    const chosen = $('savedProjects').value;
    globalThis.GXT.i18n.bind($('savedProjects'), "innerHTML", () => (globalThis.GXT.i18n.t("pages_subtitles_listProjects_1") + list.sort((a,b) => b.savedAt-a.savedAt).map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)} · ${globalThis.GXT.i18n.date(item.savedAt)}</option>`).join('')));
    if (list.some(p => p.id === chosen)) $('savedProjects').value = chosen;
    $('restoreProjectBtn').disabled = !$('savedProjects').value;
  }
  function scheduleSave() {
    if (!project) return;
    clearTimeout(saveTimer); globalThis.GXT.i18n.bind($('saveStatus'), "textContent", () => (globalThis.GXT.i18n.t("pages_subtitles_scheduleSave_1")));
    saveTimer = setTimeout(flushSave, 650);
  }
  function flushSave() {
    clearTimeout(saveTimer); saveTimer = null;
    if (!project) return saveQueue;
    const owner = project, revision = project.revision, value = W.snapshot(project);
    value.outputOptions = outputOptions();
    saveQueue = saveQueue.catch(() => {}).then(async () => {
      const db = await database();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(['projects','previous'], 'readwrite');
        const store = tx.objectStore('projects'), previous = tx.objectStore('previous');
        const old = store.get(value.id);
        old.onsuccess = () => {
          try { if (old.result) previous.put(old.result); store.put(value); }
          catch (error) { tx.abort(); reject(error); }
        };
        tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || Error(globalThis.GXT.i18n.t("pages_subtitles_flushSave_3")));
      });
      if (project === owner && owner.revision === revision) globalThis.GXT.i18n.bind($('saveStatus'), "textContent", () => (globalThis.GXT.i18n.t("pages_subtitles_flushSave_2", {v0:(globalThis.GXT.i18n.time(value.savedAt))})));
      await listProjects();
    }).catch(error => { if (project === owner) globalThis.GXT.i18n.bind($('saveStatus'), "textContent", () => (globalThis.GXT.i18n.t("pages_subtitles_flushSave_1", {v0:(String(error?.message || error))}))); });
    return saveQueue;
  }
  async function openSnapshot(value) {
    const restored = W.restore(value); // validate before replacing current work
    const expectedJob = job;
    await flushSave();
    if (job !== expectedJob) return;
    const myJob = resetJobs(); clearDub(); clearTimeout(previewTimer);
    project = restored; session = new W.Session(project); doc = project.doc; sourceName = project.name;
    translatable = S.collectTranslatable(doc); selection.clear(); editorPage = 0;
    $('fileName').textContent = sourceName;
    globalThis.GXT.i18n.bind($('facts'), "innerHTML", () => (fact(globalThis.GXT.i18n.t("pages_subtitles_openSnapshot_4"), doc.format.toUpperCase()) + fact(globalThis.GXT.i18n.t("pages_subtitles_openSnapshot_3"), faNum(doc.cues.length)) + fact(globalThis.GXT.i18n.t("pages_subtitles_openSnapshot_2"), globalThis.GXT.i18n.t("pages_subtitles_openSnapshot_1"))));
    writeOutputOptions(value.outputOptions || {}); writeTranslation();
    $('preview').textContent = ''; show('skipNote', false); show('errorNote', false);
    syncOutputControls(); show('optRewrapRow', doc.format !== 'ass');
    writeRules(); renderEditor(); refreshOutput(); show('fileCard'); show('optionsCard'); show('editorCard');
    if (job === myJob) scheduleSave();
  }

  /** The translated cues, for the dub — same inputs as build(), minus
   *  serialization, so the two can never disagree about what was said. */
  function rebuildCues(items, results, opts) {
    const single = S.build(doc, items, results, { ...opts, bilingual: false, rtl: false, rewrap: false });
    const reparsed = S.parse(single.text, sourceName);
    return reparsed.cues;
  }

  // ------------------------------------------------------------- download

  function download(filename, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  const stem = () => sourceName.replace(/\.[^.]+$/, '');

  // ------------------------------------------------------------------ dub

  /** Decode any engine's audio to mono Float32 at DUB_RATE. Using an
   *  OfflineAudioContext pinned to that rate makes the browser resample for
   *  us, so no engine needs special handling downstream. */
  async function decodeClip(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    const context = new OfflineAudioContext(1, 1, DUB_RATE);
    const buffer = await context.decodeAudioData(bytes.buffer);
    if (buffer.numberOfChannels === 1) return buffer.getChannelData(0);
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);
    const mono = new Float32Array(left.length);
    for (let i = 0; i < left.length; i += 1) mono[i] = (left[i] + right[i]) / 2;
    return mono;
  }

  /**
   * Synthesize one segment so it fits its slot.
   *
   * Pass 1 renders at normal pace and measures. If it overruns the window, the
   * cure is a FASTER READING, not a faster playback: asking the engine for
   * `rate` re-renders the speech at the new pace with the pitch intact, while
   * resampling the finished audio would turn the voice into a chipmunk. That
   * costs one extra request — cheap, since the default engine is free and
   * unlimited, and only overrunning segments pay it.
   *
   * The rate is capped at 2×: past that Persian stops being intelligible, and
   * an honest overlap is better than an unlistenable line.
   */
  async function fitSegment(segment, available, mode, active = () => true) {
    const first = await send({ type: 'TTS_SPEAK', text: segment.text });
    if (!active()) return {};
    if (!first?.ok) return { error: first };
    let samples = await decodeClip(first.data);
    if (!active()) return {};
    let rate = 1;
    const duration = () => (samples.length / DUB_RATE) * 1000;

    if (mode === 'rate' && available > 0 && duration() > available * 1.02) {
      rate = Math.min(2, duration() / available);
      const second = await send({ type: 'TTS_SPEAK', text: segment.text, rate });
      if (second?.ok) {
        const retimed = await decodeClip(second.data);
        // Keep the retry only if it actually helped — a engine that ignores
        // the rate parameter must not make the result worse.
        if (retimed.length < samples.length) samples = retimed;
      }
    }
    return { samples, rate, overrun: Math.max(0, duration() - available) };
  }

  async function buildDub() {
    if (!outputCues?.length) return;
    const myJob = resetJobs();
    clearDub();
    const mode = $('dubFit').value;
    const merge = $('dubMerge').checked;

    const segments = merge
      ? S.toSpeechSegments(outputCues)
      : S.toSpeechSegments(outputCues, { maxGapMs: -1 });
    if (!segments.length) {
      $('dubNote').className = 'notice err';
      globalThis.GXT.i18n.bind($('dubNote'), "textContent", () => (globalThis.GXT.i18n.t("pages_subtitles_buildDub_9")));
      show('dubNote');
      return;
    }

    const totalMs = segments.reduce((last, segment) => Math.max(last, segment.end), 0) + 8000;
    const totalSamples = Math.ceil((totalMs / 1000) * DUB_RATE);
    // Bound allocations before requesting speech: timestamp input is untrusted.
    // Encoding also needs a PCM copy, so a warning alone cannot prevent OOM.
    if (!Number.isSafeInteger(totalSamples) || totalSamples > MAX_DUB_SAMPLES) {
      $('dubNote').className = 'notice err';
      globalThis.GXT.i18n.bind($('dubNote'), "textContent", () => (globalThis.GXT.i18n.t("pages_subtitles_buildDub_8")));
      show('dubNote');
      return;
    }

    show('dubProgress');
    show('dubDownloadRow', false);
    $('dubBtn').disabled = true;
    $('dubCancelBtn').disabled = false;

    let timeline;
    try {
      timeline = new Float32Array(totalSamples);
    } catch {
      resetJobs();
      $('dubNote').className = 'notice err';
      globalThis.GXT.i18n.bind($('dubNote'), "textContent", () => (globalThis.GXT.i18n.t("pages_subtitles_buildDub_7")));
      show('dubNote');
      return;
    }
    let done = 0;
    let overruns = 0;
    let sped = 0;
    let failures = 0;
    let firstError = null;

    // Segments are rendered a few at a time but WRITTEN in order-independent
    // fashion (each owns its own slice of the timeline), so concurrency here
    // cannot reorder speech.
    const queue = segments.map((segment, i) => ({ segment, i }));
    const workers = Array.from({ length: 3 }, async () => {
      for (;;) {
        const next = queue.shift();
        if (!next || job !== myJob) return;
        const { segment, i } = next;
        const following = segments[i + 1];
        // How much room this line really has: its own window, plus the silence
        // before the next line when the user allows spilling into it.
        const own = segment.end - segment.start;
        const gap = following ? Math.max(0, following.start - segment.end) : 6000;
        const available = mode === 'strict' ? Infinity : own + (mode === 'overflow' ? gap : gap * 0.5);

        let result;
        try {
          result = await fitSegment(segment, available, mode, () => job === myJob);
        } catch (error) {
          result = { error: { error: String(error?.message || error) } };
        }
        if (job !== myJob) return;

        if (result.error || !result.samples) {
          failures += 1;
          if (!firstError) firstError = result.error;
        } else {
          if (result.rate > 1) sped += 1;
          if (result.overrun > 250) overruns += 1;
          const at = Math.floor((segment.start / 1000) * DUB_RATE);
          const samples = result.samples;
          for (let k = 0; k < samples.length; k += 1) {
            const index = at + k;
            if (index >= totalSamples) break;
            // Sum, then clamp: two lines can legitimately overlap when a long
            // one spills, and silent truncation would be worse than a mix.
            const mixed = timeline[index] + samples[k];
            timeline[index] = mixed > 1 ? 1 : mixed < -1 ? -1 : mixed;
          }
        }
        done += 1;
        const pct = Math.round((done / segments.length) * 100);
        $('dubFill').style.width = `${pct}%`;
        globalThis.GXT.i18n.bind($('dubText'), "textContent", () => (globalThis.GXT.i18n.t("pages_subtitles_workers_2", {v0:(faNum(done)), v1:(faNum(segments.length)), v2:(faNum(pct))}) +
          (failures ? globalThis.GXT.i18n.t("pages_subtitles_workers_1", {v0:(faNum(failures))}) : '')));
      }
    });
    await Promise.all(workers);
    if (job !== myJob) return;

    $('dubBtn').disabled = false;
    $('dubCancelBtn').disabled = true;
    show('dubProgress', false);

    if (failures === segments.length) {
      $('dubNote').className = 'notice err';
      globalThis.GXT.i18n.bind($('dubNote'), "textContent", () => (globalThis.GXT.i18n.t("pages_subtitles_buildDub_5", {v0:(firstError?.error || globalThis.GXT.i18n.t("pages_subtitles_buildDub_6")), v1:(firstError?.code ? ` [${firstError.code}]` : '')})));
      show('dubNote');
      return;
    }

    let wav;
    try { wav = encodeWav(timeline, DUB_RATE); }
    catch {
      $('dubNote').className = 'notice err';
      globalThis.GXT.i18n.bind($('dubNote'), "textContent", () => (globalThis.GXT.i18n.t("pages_subtitles_buildDub_4")));
      show('dubNote');
      return;
    }
    if (dubBlobUrl) URL.revokeObjectURL(dubBlobUrl);
    dubBlobUrl = URL.createObjectURL(wav);
    $('dubPreview').src = dubBlobUrl;

    const notes = [
      globalThis.GXT.i18n.t("pages_subtitles_notes_2", {v0:(faNum(segments.length))}),
      globalThis.GXT.i18n.t("pages_subtitles_notes_1", {v0:(faNum((wav.size / (1024 * 1024)).toFixed(1)))}),
    ];
    if (sped) notes.push(globalThis.GXT.i18n.t("pages_subtitles_buildDub_3", {v0:(faNum(sped))}));
    if (overruns) notes.push(globalThis.GXT.i18n.t("pages_subtitles_buildDub_2", {v0:(faNum(overruns))}));
    if (failures) notes.push(globalThis.GXT.i18n.t("pages_subtitles_buildDub_1", {v0:(faNum(failures))}));
    $('dubNote').className = `notice${failures || overruns ? ' warn' : ''}`;
    $('dubNote').textContent = notes.join(' · ');
    show('dubNote');
    show('dubDownloadRow');
  }

  /** 16-bit PCM WAV. Uncompressed on purpose: every player reads it without a
   *  codec, and mpv can load it as an external track with no re-muxing. */
  function encodeWav(samples, sampleRate) {
    const bytes = samples.length * 2;
    const buffer = new ArrayBuffer(44 + bytes);
    const view = new DataView(buffer);
    const ascii = (offset, text) => {
      for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
    };
    ascii(0, 'RIFF');
    view.setUint32(4, 36 + bytes, true);
    ascii(8, 'WAVE');
    ascii(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    ascii(36, 'data');
    view.setUint32(40, bytes, true);
    for (let i = 0; i < samples.length; i += 1) {
      const value = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(44 + i * 2, value < 0 ? value * 0x8000 : value * 0x7fff, true);
    }
    return new Blob([buffer], { type: 'audio/wav' });
  }

  // ------------------------------------------------------------------ wire

  function wire() {
    const drop = $('drop');
    const picker = $('picker');
    drop.addEventListener('click', () => picker.click());
    drop.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); picker.click(); }
    });
    picker.addEventListener('change', () => {
      if (picker.files?.[0]) void loadFile(picker.files[0]);
      picker.value = '';
    });
    for (const type of ['dragenter', 'dragover']) {
      drop.addEventListener(type, (event) => { event.preventDefault(); drop.classList.add('over'); });
    }
    for (const type of ['dragleave', 'drop']) {
      drop.addEventListener(type, (event) => { event.preventDefault(); drop.classList.remove('over'); });
    }
    drop.addEventListener('drop', (event) => {
      const file = event.dataTransfer?.files?.[0];
      if (file) void loadFile(file);
    });
    // A file dropped anywhere on the page should work; landing outside the
    // zone otherwise makes the browser navigate away from the workbench.
    window.addEventListener('dragover', (event) => event.preventDefault());
    window.addEventListener('drop', (event) => {
      event.preventDefault();
      if (!drop.contains(event.target) && event.dataTransfer?.files?.[0]) {
        void loadFile(event.dataTransfer.files[0]);
      }
    });

    $('clearFile').addEventListener('click', () => {
      flushSave(); clearTimeout(previewTimer);
      resetJobs();
      clearDub();
      project = null; session = null; selection.clear();
      doc = null; translatable = null; output = null; outputCues = null; sourceName = '';
      for (const id of ['fileCard', 'optionsCard', 'editorCard', 'resultCard', 'dubCard', 'errorNote']) show(id, false);
    });

    $('translateBtn').addEventListener('click', () => void translate({ force: true }));
    $('resumeBtn').addEventListener('click', () => void translate());
    $('cancelBtn').addEventListener('click', () => {
      resetJobs(); renderEditor();
      if (project?.rows.some(row => row.translation)) refreshOutput();
      flushSave();
      globalThis.GXT.i18n.bind($('saveStatus'), "textContent", () => (globalThis.GXT.i18n.t("pages_subtitles_wire_7")));
    });

    $('downloadBtn').addEventListener('click', () => {
      if (!output) return;
      const format = $('exportFormat').value;
      const ext = format === 'original' ? doc.format : format;
      let text = output.text;
      if (format !== 'original' && format !== doc.format) {
        const built = S.parse(output.text, sourceName);
        const cues = built.cues.filter(c => !/^comment$/i.test(c.kind || '') && !/\\p[1-9]/.test(c.text || '')).map(c => ({ ...c, text: c.text.replace(/\{[^}]*\}/g, '').replace(/\\[Nn]/g, '\n').replace(/\\h/g, ' ') }));
        text = format === 'vtt' ? S._internal.serializeVtt(cues) : S._internal.serializeSrt(cues);
      }
      download(`${stem()}.fa.${ext}`, new Blob([text], { type: 'text/plain;charset=utf-8' }));
    });
    $('copyBtn').addEventListener('click', async () => {
      if (!output) return;
      try {
        await navigator.clipboard.writeText(output.text);
      } catch {
        showError(globalThis.GXT.i18n.t("pages_subtitles_wire_6"));
        return;
      }
      globalThis.GXT.i18n.bind($('copyBtn'), "textContent", () => (globalThis.GXT.i18n.t("content_ui_copyBtn_2")));
      setTimeout(() => (globalThis.GXT.i18n.bind($('copyBtn'), "textContent", () => (globalThis.GXT.i18n.t("pages_subtitles_wire_5")))), 1400);
    });

    $('dubBtn').addEventListener('click', () => void buildDub());
    $('dubCancelBtn').addEventListener('click', () => {
      job += 1;
      $('dubBtn').disabled = false;
      $('dubCancelBtn').disabled = true;
      show('dubProgress', false);
    });
    $('dubDownloadBtn').addEventListener('click', () => {
      if (!dubBlobUrl) return;
      const a = document.createElement('a');
      a.href = dubBlobUrl;
      a.download = `${stem()}.fa.wav`;
      a.click();
    });

    const outputChanged = () => { syncOutputControls(); if (project) { project.revision++; if (output) edited(); else scheduleSave(); } };
    for (const id of ['optFont','fontName','optRtl','optRewrap','optBilingual','outputFontSize','outputOutline','outputAlignment']) $(id).addEventListener('change', outputChanged);
    $('fontPreset').addEventListener('change', () => { if ($('fontPreset').value !== 'custom') $('fontName').value = $('fontPreset').value; else { $('fontName').focus(); $('fontName').select(); } outputChanged(); });
    for (const id of ['fontName','outputFontSize','outputOutline']) $(id).addEventListener('input', () => { syncOutputControls(); });
    $('resetOutputStyleBtn').addEventListener('click', () => { for (const id of ['outputFontSize','outputOutline','outputAlignment']) $(id).value = ''; outputChanged(); });
    $('workshopProvider').addEventListener('change', () => {
      modelListRevision++; $('workshopModel').value = ''; $('workshopThinking').value = 'auto'; $('workshopThinkingBudget').value = '';
      translationChanged();
    });
    GXTS.targetInput($('workshopTargetLang'),true);
    for (const id of ['workshopTargetLang','workshopModel','workshopTemperature','workshopThinking','workshopThinkingBudget','workshopCustomPrompt']) $(id).addEventListener('input', () => {
      if (id === 'workshopModel') { $('workshopThinking').value = 'auto'; $('workshopThinkingBudget').value = ''; }
      translationChanged();
    });
    $('resetTranslationBtn').addEventListener('click', () => {
      if (!project) return; project.translation = translationDefaults(); writeTranslation(); translationChanged();
    });
    $('refreshWorkshopModels').addEventListener('click', () => void refreshWorkshopModels());
    for (const id of ['glossary','characters','workshopStyle','workshopInstructions']) $(id).addEventListener('input', () => {
      if (!project) return;
      if (session?.active) { resetJobs(); showError(globalThis.GXT.i18n.t("pages_subtitles_wire_4")); }
      readRules(); project.revision++; renderEditor(); scheduleSave();
    });
    for (const id of ['searchText','onlyQa']) $(id).addEventListener('input', () => { editorPage = 0; renderEditor(); });
    $('previousPage').addEventListener('click', () => { editorPage--; renderEditor(); });
    $('nextPage').addEventListener('click', () => { editorPage++; renderEditor(); });
    $('selectPage').addEventListener('change', () => {
      for (const row of filteredRows().slice(editorPage * PAGE_SIZE, (editorPage + 1) * PAGE_SIZE)) {
        if ($('selectPage').checked) selection.add(row.id); else selection.delete(row.id);
      }
      renderEditor();
    });
    $('retranslateSelectionBtn').addEventListener('click', () => void translate({ ids: [...selection], force: true }));
    $('undoBtn').addEventListener('click', () => { if (project && W.undo(project)) { renderEditor(); edited(); } });
    $('replaceBtn').addEventListener('click', () => {
      if (!project) return;
      const count = W.replace(project, $('replaceFind').value, $('replaceWith').value, selection.size ? [...selection] : null);
      globalThis.GXT.i18n.bind($('selectionCount'), "textContent", () => (globalThis.GXT.i18n.t("pages_subtitles_wire_3", {v0:(faNum(count))})));
      if (count) { renderEditor(); edited(); }
    });
    $('editorRows').addEventListener('focusin', event => { if (event.target.matches('textarea')) { focusedEdit = event.target.closest('[data-id]').dataset.id; editGrouped = false; } });
    $('editorRows').addEventListener('focusout', event => {
      if (event.target.matches('textarea')) { focusedEdit = ''; editGrouped = false; setTimeout(renderEditor, 0); }
    });
    $('editorRows').addEventListener('input', event => {
      if (!project || event.target.dataset.action !== 'edit') return;
      const element = event.target.closest('[data-id]'), id = element.dataset.id;
      W.edit(project, id, event.target.value, true, focusedEdit === id && editGrouped); editGrouped = true;
      element.querySelector('[data-action="lock"]').checked = true;
      element.querySelector('[data-action="translate"]').disabled = true;
      globalThis.GXT.i18n.bind(element.querySelector('.cue-status'), "textContent", () => (globalThis.GXT.i18n.t("pages_subtitles_wire_2"))); element.classList.add('is-locked');
      element.querySelector('.cue-qa').textContent = W.qa(project.rows.find(r => r.id === id), project.rules).map(code => qaLabels[code]).join(' · ');
      $('undoBtn').disabled = false; edited();
    });
    $('editorRows').addEventListener('change', event => {
      const element = event.target.closest('[data-id]'); if (!project || !element) return;
      const id = element.dataset.id;
      if (event.target.dataset.action === 'select') { if (event.target.checked) selection.add(id); else selection.delete(id); renderEditor(); }
      if (event.target.dataset.action === 'lock') { W.lock(project, id, event.target.checked); renderEditor(); scheduleSave(); }
    });
    $('editorRows').addEventListener('click', event => {
      const element = event.target.closest('[data-id]'); if (!project || !element) return;
      const id = element.dataset.id;
      if (event.target.dataset.action === 'translate') void translate({ ids: [id], force: true });
      if (event.target.dataset.action === 'memory') {
        const row = project.rows.find(r => r.id === id), value = W.suggestions(project, row)[0];
        if (value) { W.edit(project, id, value); renderEditor(); edited(); }
      }
    });
    $('savedProjects').addEventListener('change', () => { $('restoreProjectBtn').disabled = !$('savedProjects').value; });
    $('restoreProjectBtn').addEventListener('click', async () => {
      const id = $('savedProjects').value; if (!id) return;
      const readJob = resetJobs();
      try {
        const db = await database();
        const value = await new Promise((resolve, reject) => { const request = db.transaction('projects').objectStore('projects').get(id); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
        if (job !== readJob) return;
        await openSnapshot(value);
      } catch (error) { if (job === readJob) showError(String(error?.message || error)); }
    });
    $('exportProjectBtn').addEventListener('click', () => {
      if (project) { const value = W.snapshot(project); value.outputOptions = outputOptions(); download(`${stem()}.gxtsub`, new Blob([JSON.stringify(value)], { type: 'application/json' })); }
    });
    $('importProjectBtn').addEventListener('click', () => $('projectPicker').click());
    $('projectPicker').addEventListener('change', async () => {
      const file = $('projectPicker').files?.[0]; $('projectPicker').value = ''; if (!file) return;
      const readJob = resetJobs();
      try {
        if (file.size > MAX_FILE_BYTES * 5) throw Error(globalThis.GXT.i18n.t("pages_subtitles_wire_1"));
        const value = JSON.parse(await file.text());
        if (job !== readJob) return;
        await openSnapshot(value);
      } catch (error) { if (job === readJob) showError(String(error?.message || error)); }
    });
    document.addEventListener('visibilitychange', () => { if (document.hidden) flushSave(); });
    window.addEventListener('pagehide', () => { resetJobs(); flushSave(); });
  }

  wire();
  setupFontPreview(); writeTranslation();
  void chrome.storage.local.get([GXTS.MODEL_LIST_KEY, GXTS.OPENAI_MODEL_LIST_KEY]).then(value => {
    if (Array.isArray(value[GXTS.MODEL_LIST_KEY])) modelLists.gemini = GXTS.classifyModels(value[GXTS.MODEL_LIST_KEY]).text;
    if (Array.isArray(value[GXTS.OPENAI_MODEL_LIST_KEY])) modelLists.openai = value[GXTS.OPENAI_MODEL_LIST_KEY];
    syncTranslationControls();
  }).catch(() => {});
  void listProjects().catch(error => { globalThis.GXT.i18n.bind($('saveStatus'), "textContent", () => (globalThis.GXT.i18n.t("pages_subtitles_message_2", {v0:(String(error?.message || error))}))); });
  void applyTheme();
  GXTS.onStorageChanged(({ settings, apiKeyChanged }) => {
    const changed = apiKeyChanged || (settings && currentSettings && operationSettings(settings) !== operationSettings(currentSettings));
    if (changed) {
      const running = $('translateBtn').disabled || $('dubBtn').disabled;
      resetJobs();
      clearDub();
      renderEditor();
      if (running) showError(globalThis.GXT.i18n.t("pages_subtitles_message_1"));
    }
    if (settings) void applyTheme(settings);
  });
})();
