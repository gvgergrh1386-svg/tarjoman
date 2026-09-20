'use strict';
// Deterministic races around the real dubbing engine; no provider or network.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const sourcePath = process.argv[2] || path.join(__dirname, '../content/dub.js');
const code = fs.readFileSync(sourcePath, 'utf8');
function fixture(options = {}) {
  let now = 0, sequence = 0, elementSources = 0, streamSources = 0;
  const timers = new Map(), allTimers = [], contexts = [], ports = [], owned = [];
  const eventful = (object = {}) => Object.assign(object, { listeners: new Map(),
    addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); },
    removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); },
    emit(type) { for (const fn of [...(this.listeners.get(type) || [])]) fn({ type }); },
  });
  function track({ muted = false, readyState = 'live' } = {}) {
    return eventful({ kind: 'audio', enabled: true, muted, readyState, stopped: 0,
      stop() { this.stopped++; this.readyState = 'ended'; },
      clone() { const clone = track({ muted: this.muted, readyState: this.readyState }); owned.push(clone); return clone; },
    });
  }
  class MediaStream { constructor(tracks) { this.tracks = tracks; } getAudioTracks() { return this.tracks.filter(t => t.kind === 'audio'); } getTracks() { return this.tracks; } }
  const video = eventful({ volume: 0.8, muted: false, paused: false, seeking: false, ended: false, playbackRate: 1, currentTime: 0 });
  const node = () => ({ gain: { value: 1 }, connections: [], disconnects: 0, connect(other) { this.connections.push(other); }, disconnect() { this.disconnects++; } });
  function context() {
    const ctx = { state: 'running', sampleRate: 48000, destination: {}, gains: [], sources: [], taps: [],
      get currentTime() { return 100 + now / 1000; }, resume: async () => {}, close() { this.closed = true; return Promise.resolve(); },
      createGain() { const n = node(); this.gains.push(n); return n; },
      createMediaElementSource() { elementSources++; return node(); },
      createMediaStreamSource(stream) { streamSources++; this.stream = stream; return node(); },
      createScriptProcessor() { const n = node(); this.taps.push(n); return n; },
      createBuffer(channels, samples, rate) { const data = new Float32Array(samples); return { duration: samples / rate, getChannelData: () => data }; },
      createBufferSource() { const n = Object.assign(node(), { playbackRate: { value: 1 }, stopped: false, start(at) { this.at = at; }, stop() { this.stopped = true; } }); this.sources.push(n); return n; },
      decodeAudioData: async () => ({ duration: 1 }),
    }; contexts.push(ctx); return ctx;
  }
  function port() { const listeners = [], disconnects = []; const p = { sent: [], onMessage: { addListener: f => listeners.push(f) }, onDisconnect: { addListener: f => disconnects.push(f) }, postMessage(m) { this.sent.push(m); }, emit(m) { listeners.forEach(f => f(m)); }, disconnect() { disconnects.forEach(f => f()); } }; ports.push(p); return p; }
  const timer = (fn, ms, repeat) => { const id = ++sequence; const t = { id, fn, due: now + ms, ms, repeat }; timers.set(id, t); allTimers.push(t); return id; };
  const sandbox = { console, Float32Array, Uint8Array, DataView, ArrayBuffer, MediaStream,
    Date: class extends Date { static now() { return now; } },
    btoa: value => Buffer.from(value, 'binary').toString('base64'), atob: value => Buffer.from(value, 'base64').toString('binary'),
    setInterval: (fn, ms) => timer(fn, ms, true), clearInterval: id => timers.delete(id),
    setTimeout: (fn, ms) => timer(fn, ms, false), clearTimeout: id => timers.delete(id), document: eventful(),
  };
  vm.runInNewContext(code, sandbox, { filename: sourcePath });
  sandbox.GXT.dub._internal.setContextFactory(context);
  sandbox.GXT.dub._internal.setRampMs(options.ramp ?? 0);
  const settings = { ytDubDuck: 12, ytLiveDuck: 15, ytLiveModel: 'test-model', ytLiveSourceLang: '' };
  const engine = sandbox.GXT.dub.create({ video, settings, send: async () => ({ ok: true, data: 'AAAA' }), connectLive: port, ...options.config });
  function advance(ms) { const end = now + ms; let guard = 0; for (;;) { const next = [...timers.values()].sort((a,b) => a.due-b.due)[0]; if (!next || next.due > end) break; if (++guard > 10000) throw Error('timer runaway'); now = next.due; if (next.repeat) next.due += next.ms; else timers.delete(next.id); next.fn(); } now = end; }
  function caption(id = 'same', start = 0) { engine.setSegments([{ id, start, end: start + 1000, text: 'سلام' }]); engine._test.ready.set(id, { buffer: { duration: 1 }, rate: 1 }); engine.update(); return contexts[0].sources.at(-1); }
  function speech(seconds = 0.5) { ports.at(-1).emit({ t: 'audio', data: Buffer.alloc(24000 * seconds * 2, 16).toString('base64'), rate: 24000 }); }
  const originalGain = () => contexts[0].gains[1].gain.value;
  return { engine, video, settings, contexts, ports, track, MediaStream, owned, advance, caption, speech, timers, allTimers, originalGain,
    get elementSources() { return elementSources; }, get streamSources() { return streamSources; } };
}
const tests = [];
const test = (name, run) => tests.push({ name, run });
const near = (a,b) => assert.ok(Math.abs(a-b) < 0.001, `${a} != ${b}`);
test('inactive configure never changes source volume', () => { const f = fixture(); f.engine.configure({ ...f.settings, ytLiveDuck: 0 }); near(f.video.volume, 0.8); assert.equal(f.contexts.length, 0); });
test('stopped Live passthrough stays full after settings refresh', () => { const f = fixture(); f.engine.start('live'); f.engine.stop(); f.engine.configure({ ...f.settings, ytLiveDuck: 0 }); near(f.originalGain(), 1); });
test('failed Live passthrough stays full after settings refresh', () => { const f = fixture(); f.engine.start('live'); f.ports[0].emit({ t:'state', state:'error', error:{code:'DENIED'} }); f.engine.configure({ ...f.settings, ytLiveDuck: 0 }); near(f.originalGain(), 1); assert.equal(f.engine.stats().running, false); });
test('Live connecting and listening do not duck before translated speech', () => { const f = fixture(); f.engine.start('live'); near(f.originalGain(), 1); f.ports[0].emit({t:'state',state:'live'}); near(f.originalGain(),1); });
test('Live ducks only audible chunk and releases after its end', () => { const f = fixture(); f.engine.start('live'); f.speech(); near(f.originalGain(),1); f.advance(210); near(f.originalGain(),0.15); f.advance(510); near(f.originalGain(),1); });
test('Live pause, late state and interrupted chunks cannot retain duck', () => { const f = fixture(); f.engine.start('live'); f.speech(); f.advance(210); f.video.paused = true; f.video.emit('pause'); near(f.originalGain(),1); f.ports[0].emit({t:'state',state:'live'}); near(f.originalGain(),1); f.video.paused = false; f.video.emit('playing'); f.speech(); f.advance(210); near(f.originalGain(),0.15); f.ports.at(-1).emit({t:'audio',interrupted:true}); near(f.originalGain(),1); });
test('future caption cue does not duck early', () => { const f = fixture(); f.engine.start(); f.caption('future',1000); near(f.video.volume,0.8); f.advance(1020); near(f.video.volume,0.096); });
test('queued fade callback cannot write after stop', () => { const f = fixture({ramp:180}); f.engine.start(); f.caption(); const callbacks=f.allTimers.map(t=>t.fn); f.advance(60); f.engine.stop(); f.advance(200); callbacks.forEach(fn=>fn()); near(f.video.volume,0.8); });
test('old fade cannot overwrite fresh volume after A to B to A', () => { const f = fixture({ramp:180}); f.engine.start(); f.caption(); const callbacks=f.allTimers.map(t=>t.fn); f.advance(60); f.engine.setMode('live'); f.engine.setMode('caption'); f.engine.stop(); f.video.volume=0.35; f.engine.start(); f.advance(300); callbacks.forEach(fn=>fn()); near(f.video.volume,0.35); });
test('user volume during fading is authoritative through stop', () => { const f = fixture({ramp:180}); f.engine.start(); f.caption(); f.advance(60); f.video.volume=0.4; f.video.emit('volumechange'); f.advance(400); near(f.video.volume,0.4); f.engine.stop(); near(f.video.volume,0.4); });
test('late ended callback cannot remove reused cue or release new duck', () => { const f = fixture(); f.engine.start(); const old=f.caption(); const ended=old.onended; f.engine.stop(); f.engine.start(); const current=f.caption(); ended(); assert.equal(f.engine._test.scheduled.get('same')?.source,current); near(f.video.volume,0.096); });
test('safe stream unsupported fails before socket and never reroutes original', () => { const f = fixture({config:{captureMode:'stream'}}); f.engine.start('live'); assert.equal(f.elementSources,0); assert.equal(f.ports.length,0); near(f.video.volume,0.8); assert.equal(f.engine.stats().live.state,'error'); assert.equal(f.engine.stats().running,false); assert.ok(f.engine.stats().error?.code); });
test('safe srcObject uses owned audio clones and sends PCM without captions', () => { const f=fixture({config:{captureMode:'stream'}}); const original=f.track(); f.video.srcObject=new f.MediaStream([original]); f.engine.start('live'); assert.equal(f.elementSources,0); assert.equal(f.streamSources,1); assert.equal(f.engine.stats().total,0); const tap=f.contexts[0].taps[0]; tap.onaudioprocess({inputBuffer:{getChannelData:()=>new Float32Array(4096).fill(0.2)}}); assert.ok(f.ports[0].sent.some(m=>m.t==='audio'&&m.data.length>0)); const start=f.ports[0].sent.find(m=>m.t==='start'); assert.equal(start.model,'test-model'); assert.equal(start.sourceLang,'auto'); f.engine.stop(); assert.equal(original.stopped,0); assert.ok(f.owned.length&&f.owned.every(t=>t.stopped===1)); assert.equal(tap.onaudioprocess,null); assert.equal(f.engine.dispose(),true); });
test('muted cross-origin capture rejects before remote session', () => { const f=fixture({config:{captureMode:'stream'}}); const captured=f.track({muted:true}); f.video.captureStream=()=>new f.MediaStream([captured]); f.engine.start('live'); assert.equal(f.elementSources,0); assert.equal(f.ports.length,0); assert.equal(f.engine.stats().live.state,'error'); near(f.video.volume,0.8); assert.equal(captured.stopped,1); });
test('stream track mute while playing fails and restores owned volume', () => { const f=fixture({config:{captureMode:'stream'}}); const original=f.track(); f.video.srcObject=new f.MediaStream([original]); f.engine.start('live'); f.speech(); f.advance(210); near(f.video.volume,0.12); const captured=f.contexts[0].stream.getAudioTracks()[0]; captured.muted=true; captured.emit('mute'); assert.equal(f.engine.stats().running,false); near(f.video.volume,0.8); assert.equal(original.stopped,0); });
test('natural paused stream mute is not a fatal capture error', () => { const f=fixture({config:{captureMode:'stream'}}); f.video.srcObject=new f.MediaStream([f.track()]); f.engine.start('live'); f.video.paused=true; f.video.emit('pause'); const captured=f.contexts[0].stream.getAudioTracks()[0]; captured.muted=true; captured.emit('mute'); assert.equal(f.engine.stats().running,true); near(f.video.volume,0.8); });
test('old capture callback and port cannot send or duck after restart', () => { const f=fixture({config:{captureMode:'stream'}}); f.video.srcObject=new f.MediaStream([f.track()]); f.engine.start('live'); const oldTap=f.contexts[0].taps[0].onaudioprocess, oldPort=f.ports[0]; f.engine.stop(); f.engine.start('live'); const before=f.ports[1].sent.length; oldTap({inputBuffer:{getChannelData:()=>new Float32Array(4096).fill(.2)}}); oldPort.emit({t:'audio',data:'AAAA'}); assert.equal(f.ports[1].sent.length,before); near(f.video.volume,.8); });
test('pause and resume retire pre-pause server audio instead of replaying it', () => { const f=fixture(); f.engine.start('live'); const old=f.ports[0]; f.video.paused=true; f.video.emit('pause'); f.video.paused=false; f.video.emit('playing'); assert.equal(f.ports.length,2); old.emit({t:'audio',data:'AAAA'}); assert.equal(f.engine._test.liveSources.size,0); near(f.originalGain(),1); f.speech(); f.advance(210); near(f.originalGain(),.15); });
test('paused Live startup waits for playable media before opening session', () => { const f=fixture({config:{captureMode:'stream'}}); f.video.paused=true; f.video.srcObject=new f.MediaStream([f.track()]); f.engine.start('live'); assert.equal(f.ports.length,0); assert.equal(f.engine.stats().running,true); near(f.video.volume,.8); f.video.paused=false; f.video.emit('playing'); assert.equal(f.ports.length,1); assert.equal(f.engine.stats().running,true); });
test('user slider change immediately before stop survives its queued volume event', () => { const f=fixture(); f.engine.start(); f.caption(); f.video.volume=.22; f.engine.stop(); near(f.video.volume,.22); });
let pass=0;
for (const t of tests) { try { t.run(); pass++; console.log(`PASS ${t.name}`); } catch (error) { console.log(`FAIL ${t.name}: ${error.message}`); } }
console.log(`SUMMARY ${pass}/${tests.length}`);
process.exitCode = pass===tests.length?0:1;
