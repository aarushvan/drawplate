// Drawplate Slewbox: Browser Web Audio Engine (AudioWorklet + Fallback + Analyser + WebMIDI + WAV Export)

import {
  CURATED_PATCHES,
  PATCH_MAP,
  resolvePatch,
  midiToHz,
  renderPatchToWav,
} from './wav.mjs';

export { CURATED_PATCHES, PATCH_MAP, resolvePatch, midiToHz, renderPatchToWav };

export class SlewboxEngine {
  constructor(options = {}) {
    this.patch = resolvePatch(options.patch || 'saw');
    this.ctx = null;
    this.workletNode = null;
    this.analyser = null;
    this.masterGain = null;
    this.mode = 'idle'; // 'idle' | 'worklet' | 'fallback'
    this.midiAccess = null;
    this.midiInputs = [];
    this.activeNotes = new Set();
    this._fallbackVoices = new Map();
    this._timeBuffer = null;
    this._freqBuffer = null;
    this._initPromise = null;
  }

  async init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') {
        await this.ctx.resume();
      }
      return { ok: true, mode: this.mode, sampleRate: this.ctx.sampleRate };
    }
    if (this._initPromise) return this._initPromise;

    this._initPromise = this._doInit();
    return this._initPromise;
  }

  async _doInit() {
    const AudioCtx = typeof window !== 'undefined'
      ? (window.AudioContext || window.webkitAudioContext)
      : null;

    if (!AudioCtx) {
      this.mode = 'unavailable';
      return { ok: false, mode: 'unavailable', sampleRate: 48000 };
    }

    this.ctx = new AudioCtx({ sampleRate: 48000 });
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }

    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 0.9;

    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.78;
    this._timeBuffer = new Float32Array(this.analyser.fftSize);
    this._freqBuffer = new Uint8Array(this.analyser.frequencyBinCount);

    this.masterGain.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);

    // Attempt real AudioWorkletNode first; fall back cleanly on file:// or restricted contexts
    if (this.ctx.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
      try {
        const workletUrl = new URL('./slewbox-worklet.js', import.meta.url);
        await this.ctx.audioWorklet.addModule(workletUrl.href);
        this.workletNode = new AudioWorkletNode(this.ctx, 'slewbox-processor', {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [2],
        });
        this.workletNode.connect(this.masterGain);
        this.workletNode.port.postMessage({ type: 'setPatch', patch: this.patch });
        this.mode = 'worklet';
        return { ok: true, mode: 'worklet', sampleRate: this.ctx.sampleRate };
      } catch {
        this.workletNode = null;
      }
    }

    this.mode = 'fallback';
    return { ok: true, mode: 'fallback', sampleRate: this.ctx.sampleRate };
  }

  getPresets() {
    return CURATED_PATCHES.map((p) => ({ ...p }));
  }

  getPatch() {
    return { ...this.patch };
  }

  setPatch(patchOrId) {
    this.patch = resolvePatch(patchOrId);
    if (this.workletNode) {
      this.workletNode.port.postMessage({ type: 'setPatch', patch: this.patch });
    }
    return this.getPatch();
  }

  setParam(key, value) {
    this.patch[key] = key === 'engine' || key === 'id' || key === 'name' ? value : Number(value);
    if (this.workletNode) {
      this.workletNode.port.postMessage({ type: 'setParam', key, value: this.patch[key] });
    } else if (this.mode === 'fallback' && this.ctx) {
      const now = this.ctx.currentTime;
      for (const voice of this._fallbackVoices.values()) {
        if (key === 'cutoff') voice.filter.frequency.setTargetAtTime(Math.max(60, Math.min(18000, this.patch.cutoff)), now, 0.015);
        if (key === 'resonance') voice.filter.Q.setTargetAtTime(0.5 + this.patch.resonance * 14, now, 0.015);
      }
    }
  }

  exportPatchJson() {
    return JSON.stringify(this.patch, null, 2);
  }

  importPatchJson(jsonString) {
    const parsed = typeof jsonString === 'string' ? JSON.parse(jsonString) : jsonString;
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Invalid Slewbox patch JSON');
    }
    return this.setPatch(parsed);
  }

  async noteOn(midiNote, velocity = 0.85) {
    const note = Number(midiNote) | 0;
    if (!this.ctx) {
      await this.init();
    } else if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }

    this.activeNotes.add(note);

    if (this.workletNode) {
      this.workletNode.port.postMessage({ type: 'noteOn', note, velocity });
      return;
    }

    if (this.mode === 'fallback' && this.ctx) {
      this._fallbackNoteOn(note, velocity);
    }
  }

  noteOff(midiNote) {
    const note = Number(midiNote) | 0;
    this.activeNotes.delete(note);

    if (this.workletNode) {
      this.workletNode.port.postMessage({ type: 'noteOff', note });
      return;
    }

    if (this.mode === 'fallback' && this.ctx) {
      this._fallbackNoteOff(note);
    }
  }

  allNotesOff() {
    this.activeNotes.clear();
    if (this.workletNode) {
      this.workletNode.port.postMessage({ type: 'allNotesOff' });
    } else {
      for (const note of [...this._fallbackVoices.keys()]) {
        this._fallbackNoteOff(note);
      }
    }
  }

  _fallbackNoteOn(note, velocity) {
    this._fallbackNoteOff(note);
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const freq = midiToHz(note);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(Math.max(60, Math.min(18000, this.patch.cutoff)), now);
    filter.Q.setValueAtTime(0.5 + (this.patch.resonance || 0.25) * 14, now);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, now);
    const peak = Math.max(0.05, velocity * (this.patch.gain ?? 0.72) * 0.45);
    env.gain.linearRampToValueAtTime(peak, now + Math.max(0.004, this.patch.attack));
    env.gain.exponentialRampToValueAtTime(
      Math.max(0.0005, peak * Math.max(0.05, this.patch.sustain)),
      now + Math.max(0.004, this.patch.attack) + Math.max(0.02, this.patch.decay)
    );

    const oscA = ctx.createOscillator();
    const oscB = ctx.createOscillator();
    if (this.patch.engine === 'fm') {
      oscA.type = 'sine';
      oscA.frequency.setValueAtTime(freq, now);
      oscB.type = 'sine';
      oscB.frequency.setValueAtTime(freq * (this.patch.fmRatio || 3.5), now);
      const modGain = ctx.createGain();
      modGain.gain.setValueAtTime(freq * (this.patch.fmIndex || 4.0) * 0.35, now);
      modGain.gain.exponentialRampToValueAtTime(0.01, now + Math.max(0.05, this.patch.fmDecay || 0.4));
      oscB.connect(modGain);
      modGain.connect(oscA.frequency);
      oscA.connect(filter);
    } else {
      oscA.type = this.patch.engine === 'granular' ? 'triangle' : 'sawtooth';
      oscB.type = this.patch.engine === 'granular' ? 'sine' : 'sawtooth';
      oscA.frequency.setValueAtTime(freq, now);
      oscA.detune.setValueAtTime(this.patch.detuneCents || 8, now);
      oscB.frequency.setValueAtTime(freq * (this.patch.engine === 'granular' ? 1.005 : 0.5), now);
      oscB.detune.setValueAtTime(-(this.patch.detuneCents || 8), now);
      oscA.connect(filter);
      oscB.connect(filter);
    }

    filter.connect(env);
    env.connect(this.masterGain);
    oscA.start(now);
    oscB.start(now);

    this._fallbackVoices.set(note, { oscA, oscB, filter, env });
  }

  _fallbackNoteOff(note) {
    const voice = this._fallbackVoices.get(note);
    if (!voice || !this.ctx) return;
    this._fallbackVoices.delete(note);
    const now = this.ctx.currentTime;
    const rel = Math.max(0.02, this.patch.release || 0.25);
    voice.env.gain.cancelScheduledValues(now);
    voice.env.gain.setValueAtTime(Math.max(0.0001, voice.env.gain.value), now);
    voice.env.gain.exponentialRampToValueAtTime(0.0001, now + rel);
    voice.oscA.stop(now + rel + 0.03);
    voice.oscB.stop(now + rel + 0.03);
  }

  getTimeDomainData(target = null) {
    if (!this.analyser) {
      return target || new Float32Array(256);
    }
    const buf = target || this._timeBuffer;
    this.analyser.getFloatTimeDomainData(buf);
    return buf;
  }

  getFrequencyData(target = null) {
    if (!this.analyser) {
      return target || new Uint8Array(128);
    }
    const buf = target || this._freqBuffer;
    this.analyser.getByteFrequencyData(buf);
    return buf;
  }

  async initMidi(onStatusChange = null) {
    if (typeof navigator === 'undefined' || typeof navigator.requestMIDIAccess !== 'function') {
      const status = { supported: false, connected: 0, devices: [] };
      if (onStatusChange) onStatusChange(status);
      return status;
    }

    try {
      this.midiAccess = await navigator.requestMIDIAccess();
      const bindInputs = () => {
        this.midiInputs = [];
        const devices = [];
        for (const input of this.midiAccess.inputs.values()) {
          devices.push(input.name || input.id);
          input.onmidimessage = (evt) => this._handleMidiMessage(evt.data);
          this.midiInputs.push(input);
        }
        const status = { supported: true, connected: devices.length, devices };
        if (onStatusChange) onStatusChange(status);
        return status;
      };
      this.midiAccess.onstatechange = bindInputs;
      return bindInputs();
    } catch {
      const status = { supported: false, connected: 0, devices: [] };
      if (onStatusChange) onStatusChange(status);
      return status;
    }
  }

  _handleMidiMessage(data) {
    if (!data || data.length < 2) return;
    const status = data[0] & 0xf0;
    const d1 = data[1];
    const d2 = data[2] ?? 0;

    if (status === 0x90 && d2 > 0) {
      this.noteOn(d1, d2 / 127);
    } else if (status === 0x80 || (status === 0x90 && d2 === 0)) {
      this.noteOff(d1);
    } else if (status === 0xb0) {
      if (d1 === 74) {
        // CC 74: Filter Cutoff (exponential 120 Hz -> 12000 Hz)
        const cut = 120 * Math.pow(100, d2 / 127);
        this.setParam('cutoff', Math.round(cut));
      } else if (d1 === 71) {
        // CC 71: Filter Resonance
        this.setParam('resonance', Number(((d2 / 127) * 0.85).toFixed(3)));
      }
    }
  }

  renderPatchToWav(patch = this.patch, midiNote = 60, durationSec = 1.5, options = {}) {
    return renderPatchToWav(patch || this.patch, midiNote, durationSec, options);
  }

  async destroy() {
    this.allNotesOff();
    for (const input of this.midiInputs) {
      input.onmidimessage = null;
    }
    this.midiInputs = [];
    if (this.workletNode) {
      this.workletNode.disconnect();
      this.workletNode = null;
    }
    if (this.ctx) {
      await this.ctx.close();
      this.ctx = null;
    }
    this.mode = 'idle';
  }
}
