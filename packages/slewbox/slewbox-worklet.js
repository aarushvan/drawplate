// Drawplate Slewbox: Lock-Free, Zero-Allocation Web Audio AudioWorkletProcessor
// Runs at audio device sampleRate (48 kHz) in 128-sample render quanta.
// Voices: 'saw' (Poly-BLEP dual detuned saw + sub), 'granular' (ring-buffer grain cloud), 'fm' (2-op FM bell).
// Signal path: Voice DSP -> 2x Oversampled Chamberlin SVF -> ADSR Envelope -> tanh Soft Clipper.

const MAX_VOICES = 8;
const MAX_GRAINS = 12;
const TABLE_SIZE = 2048;
const TABLE_MASK = TABLE_SIZE - 1;
const TWO_PI = Math.PI * 2;

function polyBlep(t, dt) {
  if (t < dt) {
    const x = t / dt;
    return x + x - x * x - 1.0;
  }
  if (t > 1.0 - dt) {
    const x = (t - 1.0) / dt;
    return x * x + x + x + 1.0;
  }
  return 0.0;
}

class SlewboxProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    // Active patch parameters (mutated cleanly via MessagePort, zero alloc in process())
    this.engineType = 0; // 0 = saw, 1 = granular, 2 = fm
    this.detuneCents = 11.0;
    this.subLevel = 0.35;
    this.grainSizeMs = 65.0;
    this.grainDensity = 24.0;
    this.pitchScatter = 0.18;
    this.fmRatio = 3.5;
    this.fmIndex = 4.8;
    this.fmDecay = 0.42;
    this.cutoff = 2400.0;
    this.resonance = 0.38;
    this.attack = 0.012;
    this.decay = 0.22;
    this.sustain = 0.68;
    this.release = 0.28;
    this.drive = 1.35;
    this.gain = 0.72;

    // Pre-allocated harmonic source wavetable for granular ring buffer
    this.grainTable = new Float32Array(TABLE_SIZE);
    for (let i = 0; i < TABLE_SIZE; i++) {
      const ph = (i / TABLE_SIZE) * TWO_PI;
      this.grainTable[i] =
        (0.52 * Math.sin(ph) +
          0.24 * Math.sin(ph * 2.0 + 0.4) +
          0.14 * Math.sin(ph * 3.0 + 1.1) +
          0.08 * Math.sin(ph * 5.0 + 0.7) +
          0.05 * Math.sin(ph * 7.0 + 2.2) +
          0.03 * Math.sin(ph * 11.0)) *
        0.85;
    }

    // Flat pre-allocated voice pool (Struct-of-Arrays for zero GC pressure)
    this.vActive = new Uint8Array(MAX_VOICES);
    this.vNote = new Int16Array(MAX_VOICES);
    this.vFreq = new Float32Array(MAX_VOICES);
    this.vVel = new Float32Array(MAX_VOICES);
    this.vAge = new Uint32Array(MAX_VOICES);
    this.vEnvStage = new Uint8Array(MAX_VOICES); // 0=off, 1=A, 2=D, 3=S, 4=R
    this.vEnvVal = new Float32Array(MAX_VOICES);
    this.vPhaseA = new Float32Array(MAX_VOICES);
    this.vPhaseB = new Float32Array(MAX_VOICES);
    this.vPhaseSub = new Float32Array(MAX_VOICES);
    this.vFmCar = new Float32Array(MAX_VOICES);
    this.vFmMod = new Float32Array(MAX_VOICES);
    this.vFmEnv = new Float32Array(MAX_VOICES);
    this.vLpL = new Float32Array(MAX_VOICES);
    this.vBpL = new Float32Array(MAX_VOICES);
    this.vLpR = new Float32Array(MAX_VOICES);
    this.vBpR = new Float32Array(MAX_VOICES);
    this.vGrainAccum = new Float32Array(MAX_VOICES);

    // Flat pre-allocated grain pool across all voices (MAX_VOICES * MAX_GRAINS)
    const totalGrains = MAX_VOICES * MAX_GRAINS;
    this.gActive = new Uint8Array(totalGrains);
    this.gPos = new Float32Array(totalGrains);
    this.gAge = new Float32Array(totalGrains);
    this.gDur = new Float32Array(totalGrains);
    this.gRate = new Float32Array(totalGrains);
    this.gPan = new Float32Array(totalGrains);

    this.rngState = 0x51e7b007;
    this.voiceCounter = 1;

    this.port.onmessage = (event) => this._handleMessage(event.data);
  }

  _nextRand() {
    let x = this.rngState | 0;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.rngState = x;
    return (x >>> 0) / 4294967296;
  }

  _applyParam(key, val) {
    if (key === 'engine') {
      if (val === 'granular') this.engineType = 1;
      else if (val === 'fm') this.engineType = 2;
      else this.engineType = 0;
      return;
    }
    const num = Number(val);
    if (!Number.isFinite(num)) return;
    switch (key) {
      case 'detuneCents': this.detuneCents = num; break;
      case 'subLevel': this.subLevel = num; break;
      case 'grainSizeMs': this.grainSizeMs = num; break;
      case 'grainDensity': this.grainDensity = num; break;
      case 'pitchScatter': this.pitchScatter = num; break;
      case 'fmRatio': this.fmRatio = num; break;
      case 'fmIndex': this.fmIndex = num; break;
      case 'fmDecay': this.fmDecay = num; break;
      case 'cutoff': this.cutoff = num; break;
      case 'resonance': this.resonance = num; break;
      case 'attack': this.attack = num; break;
      case 'decay': this.decay = num; break;
      case 'sustain': this.sustain = num; break;
      case 'release': this.release = num; break;
      case 'drive': this.drive = num; break;
      case 'gain': this.gain = num; break;
      default: break;
    }
  }

  _handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'setPatch' && msg.patch) {
      const p = msg.patch;
      for (const key in p) {
        this._applyParam(key, p[key]);
      }
    } else if (msg.type === 'setParam') {
      this._applyParam(msg.key, msg.value);
    } else if (msg.type === 'noteOn') {
      this._noteOn(msg.note | 0, Number(msg.velocity ?? 0.85));
    } else if (msg.type === 'noteOff') {
      this._noteOff(msg.note | 0);
    } else if (msg.type === 'allNotesOff') {
      for (let v = 0; v < MAX_VOICES; v++) {
        if (this.vActive[v]) this.vEnvStage[v] = 4;
      }
    }
  }

  _noteOn(midiNote, velocity) {
    // Reuse voice with same note, or free slot, or steal oldest voice
    let slot = -1;
    for (let v = 0; v < MAX_VOICES; v++) {
      if (this.vActive[v] && this.vNote[v] === midiNote) {
        slot = v;
        break;
      }
    }
    if (slot < 0) {
      for (let v = 0; v < MAX_VOICES; v++) {
        if (!this.vActive[v]) {
          slot = v;
          break;
        }
      }
    }
    if (slot < 0) {
      let oldestAge = 0xffffffff;
      slot = 0;
      for (let v = 0; v < MAX_VOICES; v++) {
        if (this.vAge[v] < oldestAge) {
          oldestAge = this.vAge[v];
          slot = v;
        }
      }
    }

    this.vActive[slot] = 1;
    this.vNote[slot] = midiNote;
    this.vFreq[slot] = 440.0 * Math.pow(2.0, (midiNote - 69) / 12.0);
    this.vVel[slot] = Math.max(0.05, Math.min(1.0, velocity));
    this.vAge[slot] = this.voiceCounter++;
    this.vEnvStage[slot] = 1;
    this.vPhaseA[slot] = 0.0;
    this.vPhaseB[slot] = 0.25;
    this.vPhaseSub[slot] = 0.0;
    this.vFmCar[slot] = 0.0;
    this.vFmMod[slot] = 0.0;
    this.vFmEnv[slot] = 1.0;
    this.vLpL[slot] = 0.0;
    this.vBpL[slot] = 0.0;
    this.vLpR[slot] = 0.0;
    this.vBpR[slot] = 0.0;
    this.vGrainAccum[slot] = 1.0; // Spawn an immediate grain on attack

    const gBase = slot * MAX_GRAINS;
    for (let g = 0; g < MAX_GRAINS; g++) {
      this.gActive[gBase + g] = 0;
    }
  }

  _noteOff(midiNote) {
    for (let v = 0; v < MAX_VOICES; v++) {
      if (this.vActive[v] && this.vNote[v] === midiNote && this.vEnvStage[v] < 4) {
        this.vEnvStage[v] = 4;
      }
    }
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    const outL = output[0];
    const outR = output.length > 1 ? output[1] : outL;
    const blockLen = outL.length;
    const sr = sampleRate;

    // Clear output block
    for (let i = 0; i < blockLen; i++) {
      outL[i] = 0.0;
      if (outR !== outL) outR[i] = 0.0;
    }

    const detuneRatio = Math.pow(2.0, this.detuneCents / 1200.0);
    const invDetuneRatio = 1.0 / detuneRatio;
    const clampedCut = Math.max(60.0, Math.min(this.cutoff, sr * 0.22));
    const f = Math.min(0.85, 2.0 * Math.sin((Math.PI * clampedCut) / (sr * 2.0)));
    const q = Math.max(0.14, 1.0 - Math.max(0.0, Math.min(0.92, this.resonance)));

    const atkStep = 1.0 / (Math.max(0.001, this.attack) * sr);
    const susLvl = Math.max(0.0, Math.min(1.0, this.sustain));
    const decStep = (1.0 - susLvl) / (Math.max(0.005, this.decay) * sr);
    const relStep = Math.max(susLvl, 0.02) / (Math.max(0.005, this.release) * sr);
    const fmDecayCoeff = Math.exp(-1.0 / (Math.max(0.02, this.fmDecay) * sr));
    const grainStepPerSample = Math.max(4.0, Math.min(80.0, this.grainDensity)) / sr;
    const grainSamples = Math.max(64.0, this.grainSizeMs * 0.001 * sr);
    const table = this.grainTable;

    for (let v = 0; v < MAX_VOICES; v++) {
      if (!this.vActive[v]) continue;

      const baseFreq = this.vFreq[v];
      const vel = this.vVel[v];
      const incA = (baseFreq * detuneRatio) / sr;
      const incB = (baseFreq * invDetuneRatio) / sr;
      const incSub = (baseFreq * 0.5) / sr;
      const carInc = baseFreq / sr;
      const modInc = (baseFreq * this.fmRatio) / sr;
      const gBase = v * MAX_GRAINS;

      let envStage = this.vEnvStage[v];
      let envVal = this.vEnvVal[v];
      let phaseA = this.vPhaseA[v];
      let phaseB = this.vPhaseB[v];
      let phaseSub = this.vPhaseSub[v];
      let fmCar = this.vFmCar[v];
      let fmMod = this.vFmMod[v];
      let fmEnv = this.vFmEnv[v];
      let lpL = this.vLpL[v];
      let bpL = this.vBpL[v];
      let lpR = this.vLpR[v];
      let bpR = this.vBpR[v];
      let gAccum = this.vGrainAccum[v];

      for (let i = 0; i < blockLen; i++) {
        // ADSR envelope progression
        if (envStage === 1) {
          envVal += atkStep;
          if (envVal >= 1.0) {
            envVal = 1.0;
            envStage = 2;
          }
        } else if (envStage === 2) {
          envVal -= decStep;
          if (envVal <= susLvl) {
            envVal = susLvl;
            envStage = 3;
          }
        } else if (envStage === 4) {
          envVal -= relStep;
          if (envVal <= 0.0001) {
            envVal = 0.0;
            envStage = 0;
            this.vActive[v] = 0;
            break;
          }
        }

        let sigL = 0.0;
        let sigR = 0.0;

        if (this.engineType === 1) {
          // Granular cloud
          gAccum += grainStepPerSample;
          if (gAccum >= 1.0) {
            gAccum -= 1.0;
            for (let g = 0; g < MAX_GRAINS; g++) {
              const idx = gBase + g;
              if (!this.gActive[idx]) {
                this.gActive[idx] = 1;
                this.gAge[idx] = 0.0;
                this.gDur[idx] = grainSamples;
                this.gPos[idx] = this._nextRand() * TABLE_SIZE;
                const scatter = (this._nextRand() * 2.0 - 1.0) * this.pitchScatter;
                this.gRate[idx] = (baseFreq * Math.pow(2.0, scatter) * TABLE_SIZE) / sr;
                this.gPan[idx] = 0.15 + this._nextRand() * 0.7;
                break;
              }
            }
          }

          let sumL = 0.0;
          let sumR = 0.0;
          let count = 0;
          for (let g = 0; g < MAX_GRAINS; g++) {
            const idx = gBase + g;
            if (!this.gActive[idx]) continue;
            const normAge = this.gAge[idx] / this.gDur[idx];
            if (normAge >= 1.0) {
              this.gActive[idx] = 0;
              continue;
            }
            const win = 0.5 - 0.5 * Math.cos(TWO_PI * normAge);
            const pos = this.gPos[idx];
            const i0 = pos | 0;
            const frac = pos - i0;
            const s0 = table[i0 & TABLE_MASK];
            const s1 = table[(i0 + 1) & TABLE_MASK];
            const sample = (s0 + (s1 - s0) * frac) * win;
            const pan = this.gPan[idx];
            sumL += sample * (1.0 - pan * 0.65);
            sumR += sample * (0.35 + pan * 0.65);
            this.gPos[idx] = pos + this.gRate[idx];
            this.gAge[idx] += 1.0;
            count++;
          }
          const scale = count > 0 ? 1.0 / Math.sqrt(count + 1) : 1.0;
          sigL = sumL * scale;
          sigR = sumR * scale;
        } else if (this.engineType === 2) {
          // 2-op phase-modulation FM bell
          const modVal = Math.sin(fmMod * TWO_PI) * (this.fmIndex * fmEnv);
          fmEnv *= fmDecayCoeff;
          sigL = Math.sin(fmCar * TWO_PI + modVal) * 0.72;
          sigR = Math.sin((fmCar + 0.0018) * TWO_PI + modVal * 0.985) * 0.72;
          fmCar += carInc;
          if (fmCar >= 1.0) fmCar -= 1.0;
          fmMod += modInc;
          if (fmMod >= 1.0) fmMod -= 1.0;
        } else {
          // Poly-BLEP dual detuned saw + sub oscillator
          const sawA = 2.0 * phaseA - 1.0 - polyBlep(phaseA, incA);
          const sawB = 2.0 * phaseB - 1.0 - polyBlep(phaseB, incB);
          const sub = Math.sin(phaseSub * TWO_PI) * this.subLevel;
          sigL = (sawA * 0.62 + sawB * 0.38) * 0.55 + sub * 0.45;
          sigR = (sawA * 0.38 + sawB * 0.62) * 0.55 + sub * 0.45;

          phaseA += incA;
          if (phaseA >= 1.0) phaseA -= 1.0;
          phaseB += incB;
          if (phaseB >= 1.0) phaseB -= 1.0;
          phaseSub += incSub;
          if (phaseSub >= 1.0) phaseSub -= 1.0;
        }

        // 2x oversampled Chamberlin SVF
        let hpL = sigL - lpL - q * bpL;
        bpL += f * hpL;
        lpL += f * bpL;
        hpL = sigL - lpL - q * bpL;
        bpL += f * hpL;
        lpL += f * bpL;

        let hpR = sigR - lpR - q * bpR;
        bpR += f * hpR;
        lpR += f * bpR;
        hpR = sigR - lpR - q * bpR;
        bpR += f * hpR;
        lpR += f * bpR;

        const amp = envVal * vel * 0.52;
        outL[i] += lpL * amp;
        if (outR !== outL) outR[i] += lpR * amp;
      }

      this.vEnvStage[v] = envStage;
      this.vEnvVal[v] = envVal;
      this.vPhaseA[v] = phaseA;
      this.vPhaseB[v] = phaseB;
      this.vPhaseSub[v] = phaseSub;
      this.vFmCar[v] = fmCar;
      this.vFmMod[v] = fmMod;
      this.vFmEnv[v] = fmEnv;
      this.vLpL[v] = lpL;
      this.vBpL[v] = bpL;
      this.vLpR[v] = lpR;
      this.vBpR[v] = bpR;
      this.vGrainAccum[v] = gAccum;
    }

    // Master tanh soft clipper + output gain
    const drive = this.drive;
    const gain = this.gain;
    for (let i = 0; i < blockLen; i++) {
      outL[i] = Math.tanh(outL[i] * drive) * gain;
      if (outR !== outL) {
        outR[i] = Math.tanh(outR[i] * drive) * gain;
      }
    }

    return true;
  }
}

registerProcessor('slewbox-processor', SlewboxProcessor);
