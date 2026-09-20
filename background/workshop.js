'use strict';
// File-only operations: each request owns its cancellation controller and
// cache/memory generation. Project options never write global settings.
const workshopOperations = new Map();
const workshopCancelled = new Map();
const workshopOwner = sender => sender?.documentId || sender?.url || 'internal';
const workshopKey = (message, sender) => `${workshopOwner(sender)}\n${message.requestId}`;
function cancelWorkshop(message, sender) {
  if (typeof message.requestId !== 'string' || message.requestId.length > 180) return { ok: false, code: 'BAD_REQUEST' };
  const key = workshopKey(message, sender);
  const controller = workshopOperations.get(key);
  controller?.abort();
  workshopCancelled.set(key, Date.now());
  for (const [id, time] of workshopCancelled) if (Date.now() - time > 120000 || workshopCancelled.size > 128) workshopCancelled.delete(id);
  return { ok: true, cancelled: true };
}
async function translateWorkshop(message, sender) {
  const fail = () => ({ ok: false, code: 'BAD_REQUEST', get error() { return globalThis.GXT.i18n.t("background_workshop_fail_1"); } });
  if (typeof message.requestId !== 'string' || !message.requestId || message.requestId.length > 180 ||
      !Array.isArray(message.cues) || !message.cues.length || message.cues.length > 60) return fail();
  const ids = new Set();
  let size = 0;
  const cues = [];
  for (const cue of message.cues) {
    if (typeof cue?.id !== 'string' || !cue.id || cue.id.length > 180 || ids.has(cue.id) || typeof cue.text !== 'string' ||
        !Number.isFinite(cue.start) || !Number.isFinite(cue.end) || cue.start < 0 || cue.end < cue.start) return fail();
    ids.add(cue.id); size += cue.text.length;
    cues.push({ id: cue.id, text: cue.text, start: cue.start, end: cue.end, speaker: String(cue.speaker || '').slice(0, 160) });
  }
  if (size > 16000) return fail();
  const context = value => Array.isArray(value) ? value.slice(-6).map(c => ({ id:String(c?.id || '').slice(0,180), text:String(c?.text || '').slice(0,2000), translated:String(c?.translated || c?.translation || '').slice(0,2000), speaker:String(c?.speaker || '').slice(0,160) })) : [];
  const contextBefore = context(message.contextBefore), contextAfter = context(message.contextAfter).slice(0, 3);
  if (JSON.stringify([contextBefore, contextAfter]).length > 16000) return fail();
  const terms = value => Array.isArray(value) ? value.slice(0,300).filter(t => typeof t?.source === 'string' && typeof t?.target === 'string').map(t => ({ source:t.source.slice(0,200), target:t.target.slice(0,200) })) : [];
  const rules = { glossary:terms(message.rules?.glossary), characters:terms(message.rules?.characters), style:['formal','colloquial'].includes(message.rules?.style) ? message.rules.style : 'natural', instructions:String(message.rules?.instructions || '').slice(0,3000) };
  const payload = { cues, contextBefore, contextAfter, rules, repair:message.repair === true };
  const options = GXTBG.workshop.normalizeTranslation(message.translation);
  if (message.translation != null && (typeof message.translation !== 'object' || Array.isArray(message.translation) ||
      Object.entries(options).some(([name,value]) => message.translation[name] != null && message.translation[name] !== value))) return fail();
  const key = workshopKey(message, sender);
  if (workshopOperations.has(key)) return { ok:false, code:'DUPLICATE_REQUEST' };
  if (workshopCancelled.has(key)) { workshopCancelled.delete(key); return {ok:false, code:'CANCELLED'}; }
  if (workshopOperations.size >= 12) return { ok:false, code:'BUSY', get error() { return globalThis.GXT.i18n.t("background_workshop_translateWorkshop_1"); } };
  const controller = new AbortController();
  workshopOperations.set(key, controller);
  const timer = setTimeout(() => controller.abort(), 90000);
  const cacheGeneration = GXTBG.cache.generation(), memoryGeneration = GXTBG.memoryGeneration();
  try {
    const settings = GXTBG.forScope(await GXTBG.getSettings(),'file');
    GXTBG.abort.check(controller.signal);
    const scoped = { ...settings, glossary:[settings.glossary || '', ...rules.glossary.map(t => `${t.source} = ${t.target}`), ...rules.characters.map(t => `${t.source} = ${t.target}`)].join('\n'),
      register:rules.style === 'formal' ? 'formal' : rules.style === 'colloquial' ? 'casual' : settings.register };
    scoped.targetLang = options.targetLang || settings.targetLang || 'fa';
    if (options.provider !== 'inherit') scoped.provider = options.provider;
    if (options.model && !['google','bing'].includes(scoped.provider)) scoped[scoped.provider === 'openai' ? 'openaiModel' : 'model'] = options.model;
    const ctx = await getProviderCtx(scoped);
    if (!ctx.configured) return {ok:false, code:'NO_KEY'};
    if (!ctx.isMT) {
      ctx.setExtra({ ...ctx.extra,
        ...(options.temperature != null ? {temperature:options.temperature} : {}),
        workshopThinking: {level:options.thinking === 'auto' ? (ctx.extra?.thinkingLevel || 'auto') : options.thinking, budget:options.thinkingBudget},
        workshopOptions: options });
    }
    await attachMemory(ctx, cues.map(c => c.text));
    GXTBG.abort.check(controller.signal);
    const cacheKey = await GXTBG.cache.keyFor(JSON.stringify([payload,options,ctx.extra]), `workshop-v${GXTBG.subtitlePrompts.VERSION}`, ctx.cacheId, 0);
    const hit = (await GXTBG.cache.getMany([cacheKey]))[cacheKey];
    GXTBG.abort.check(controller.signal);
    if (hit?.t) {
      try { const validated = GXTBG.subtitlePrompts.parseWorkshop(hit.t, cues); if (!validated.invalid) return {ok:true,...validated,cached:true,provider:ctx.provider}; } catch { /* corrupt cache becomes a miss */ }
    }
    const signal = controller.signal;
    let work;
    if (ctx.isMT) {
      work = GXTBG.mt.translateTexts(cues.map(c => c.text), { engine:ctx.provider, targetLang:scoped.targetLang || 'fa', signal }).then(result => {
        if (!Array.isArray(result.list) || result.list.length !== cues.length) return {entries:[],invalid:true};
        return GXTBG.subtitlePrompts.parseWorkshop(JSON.stringify({entries:result.list.map((text,i) => ({id:cues[i].id,text}))}), cues);
      });
    } else if (ctx.provider === 'openai') {
      work = GXTBG.openai.translateWorkshop(payload, {key:await GXTBG.getOpenaiKey(),model:scoped.openaiModel,baseUrl:scoped.openaiBaseUrl,fallbackModel:options.model ? '' : scoped.openaiFallbackModel,extra:ctx.extra,signal});
    } else {
      work = GXTBG.gemini.translateWorkshop(payload, {keys:ctx.keys,model:scoped.model,extra:ctx.extra,signal,exactModel:!!options.model});
    }
    const result = await GXTBG.abort.wait(work, signal);
    GXTBG.abort.check(signal);
    if (!result.invalid && !result.softFallback && result.entries.length === cues.length) await GXTBG.cache.setMany([[cacheKey,{t:JSON.stringify({entries:result.entries})}]], {generation:cacheGeneration});
    GXTBG.abort.check(signal);
    const byId = new Map(result.entries.map(e => [e.id,e.text]));
    if((scoped.targetLang || 'fa') === 'fa') learnFrom(cues.map(c=>c.text), cues.map(c=>byId.get(c.id)), memoryGeneration);
    void bumpStats({apiCalls:1,dayApiCalls:1,translated:result.entries.length,items_subtitle:result.entries.length});
    return {ok:true,entries:result.entries,partial:!!result.invalid,provider:ctx.provider,model:result.model || '',softFallback:!!result.softFallback,contextAware:!ctx.isMT};
  } catch (error) {
    return {ok:false,code:error.code || 'ERR',error:scrub(error.message || error)};
  } finally {
    clearTimeout(timer);
    if (workshopOperations.get(key) === controller) workshopOperations.delete(key);
    workshopCancelled.delete(key);
  }
}
