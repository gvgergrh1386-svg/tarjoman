'use strict';
// Deterministic races around the real dubbing engine; no provider or network.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const sourcePath = path.join(process.argv[2] || path.join(__dirname, '..'), 'content/dub.js');
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

module.exports={fixture};
