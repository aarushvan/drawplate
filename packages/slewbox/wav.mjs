// Drawplate Slewbox: Pure PCM16 RIFF WAV Encoder, Curated Patches, and Reference Offline DSP Renderer
// Pure isomorphic ESM (works identically in Node 22+ and Browser).

export const DEFAULT_SAMPLE_RATE = 48000;
const TWO_PI = Math.PI * 2;

export const CURATED_PATCHES = [
  {
    id: 'saw',
    name: 'Saw Lead',
    engine: 'saw',
    description: 'Poly-BLEP anti-aliased detuned dual sawtooth with sub-oscillator and resonant SVF.',
    detuneCents: 11,
    subLevel: 0.35,
    grainSizeMs: 60,
    grainDensity: 20,
    pitchScatter: 0.12,
    fmRatio: 2.0,
    fmIndex: 2.0,
    fmDecay: 0.35,
    cutoff: 2400,
    resonance: 0.38,
    attack: 0.012,
    decay: 0.22,
    sustain: 0.68,
    release: 0.28,
    drive: 1.35,
    gain: 0.72,
  },
  {
    id: 'granular',
    name: 'Granular Cloud',
    engine: 'granular',
    description: 'Wavetable ring-buffer grain cloud scheduler with Hann windows, density, and pitch scatter.',
    detuneCents: 6,
    subLevel: 0.15,
    grainSizeMs: 68,
    grainDensity: 26,
    pitchScatter: 0.18,
    fmRatio: 2.0,
    fmIndex: 1.5,
    fmDecay: 0.3,
    cutoff: 3600,
    resonance: 0.22,
    attack: 0.08,
    decay: 0.35,
    sustain: 0.75,
    release: 0.45,
    drive: 1.15,
    gain: 0.76,
  },
  {
    id: 'fm',
    name: 'FM Bell',
    engine: 'fm',
    description: '2-operator phase-modulation FM bell with inharmonic ratio and decaying modulation index.',
    detuneCents: 3,
    subLevel: 0.0,
    grainSizeMs: 55,
    grainDensity: 18,
    pitchScatter: 0.1,
    fmRatio: 3.5,
    fmIndex: 4.8,
    fmDecay: 0.42,
    cutoff: 6200,
    resonance: 0.15,
    attack: 0.004,
    decay: 0.65,
    sustain: 0.14,
    release: 0.85,
    drive: 1.1,
    gain: 0.78,
  },
  {
    id: 'sub',
    name: 'Sub Pulse',
    engine: 'saw',
    description: 'Weighted sub-octave bass driven through a warm low-pass Chamberlin SVF and soft clipper.',
    detuneCents: 4,
    subLevel: 0.78,
    grainSizeMs: 60,
    grainDensity: 16,
    pitchScatter: 0.08,
    fmRatio: 1.5,
    fmIndex: 1.2,
    fmDecay: 0.25,
    cutoff: 680,
    resonance: 0.48,
    attack: 0.008,
    decay: 0.18,
    sustain: 0.72,
    release: 0.22,
    drive: 1.55,
    gain: 0.76,
  },
];

export const PATCH_MAP = Object.fromEntries(CURATED_PATCHES.map((p) => [p.id, p]));

export function resolvePatch(patchOrId) {
  if (typeof patchOrId === 'string') {
    const found = PATCH_MAP[patchOrId];
    if (!found) {
      throw new Error(`Unknown Slewbox patch "${patchOrId}" (expected one of: ${CURATED_PATCHES.map((p) => p.id).join(', ')})`);
    }
    return { ...found };
  }
  if (patchOrId && typeof patchOrId === 'object') {
    const base = PATCH_MAP[patchOrId.id] || PATCH_MAP[patchOrId.engine] || CURATED_PATCHES[0];
    return { ...base, ...patchOrId };
  }
  return { ...CURATED_PATCHES[0] };
}

export function midiToHz(midiNote) {
  return 440 * Math.pow(2, (Number(midiNote) - 69) / 12);
}

// Deterministic xorshift32 PRNG for reproducible granular scatter
function nextRand(state) {
  let x = state.s | 0;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  state.s = x;
  return ((x >>> 0) / 4294967296);
}

// Poly-BLEP residual to suppress aliasing at sawtooth phase discontinuity
export function polyBlep(t, dt) {
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

// Build harmonic-rich 2048-sample source wavetable for granular ring buffer
export function buildGranularTable(size = 2048) {
  const table = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    const ph = (i / size) * TWO_PI;
    const val =
      0.52 * Math.sin(ph) +
      0.24 * Math.sin(ph * 2.0 + 0.4) +
      0.14 * Math.sin(ph * 3.0 + 1.1) +
      0.08 * Math.sin(ph * 5.0 + 0.7) +
      0.05 * Math.sin(ph * 7.0 + 2.2) +
      0.03 * Math.sin(ph * 11.0);
    table[i] = val * 0.85;
  }
  return table;
}

// Encode stereo or mono Float32Array channels into a valid 16-bit PCM RIFF WAV Uint8Array
export function encodeWavPcm16(left, right = null, sampleRate = DEFAULT_SAMPLE_RATE) {
  const numFrames = left.length;
  const numChannels = right ? 2 : 1;
  const bitsPerSample = 16;
  const blockAlign = (numChannels * bitsPerSample) >> 3;
  const byteRate = sampleRate * blockAlign;
  const dataSize = numFrames * blockAlign;
  const totalSize = 44 + dataSize;

  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  // RIFF chunk descriptor
  bytes.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
  view.setUint32(4, 36 + dataSize, true);
  bytes.set([0x57, 0x41, 0x56, 0x45], 8); // "WAVE"

  // fmt sub-chunk
  bytes.set([0x66, 0x6d, 0x74, 0x20], 12); // "fmt "
  view.setUint32(16, 16, true); // PCM subchunk size
  view.setUint16(20, 1, true); // AudioFormat = 1 (PCM)
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  // data sub-chunk
  bytes.set([0x64, 0x61, 0x74, 0x61], 36); // "data"
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < numFrames; i++) {
    const sL = Math.max(-1, Math.min(1, Number.isFinite(left[i]) ? left[i] : 0));
    view.setInt16(offset, Math.round(sL * 32767), true);
    offset += 2;
    if (numChannels === 2) {
      const sR = Math.max(-1, Math.min(1, Number.isFinite(right[i]) ? right[i] : 0));
      view.setInt16(offset, Math.round(sR * 32767), true);
      offset += 2;
    }
  }

  return bytes;
}

// Parse and validate a PCM16 RIFF WAV Uint8Array header
export function parseWavHeader(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 44) {
    throw new Error('Invalid WAV buffer: shorter than 44-byte RIFF header');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const readTag = (off) =>
    String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]);

  const riff = readTag(0);
  const chunkSize = view.getUint32(4, true);
  const wave = readTag(8);
  const fmt = readTag(12);
  const audioFormat = view.getUint16(20, true);
  const channels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const byteRate = view.getUint32(28, true);
  const blockAlign = view.getUint16(32, true);
  const bitsPerSample = view.getUint16(34, true);
  const dataTag = readTag(36);
  const dataSize = view.getUint32(40, true);

  const valid =
    riff === 'RIFF' &&
    wave === 'WAVE' &&
    fmt === 'fmt ' &&
    audioFormat === 1 &&
    dataTag === 'data' &&
    44 + dataSize === bytes.byteLength;

  return {
    valid,
    riff,
    wave,
    chunkSize,
    audioFormat,
    channels,
    sampleRate,
    byteRate,
    blockAlign,
    bitsPerSample,
    dataSize,
    numFrames: blockAlign > 0 ? Math.floor(dataSize / blockAlign) : 0,
  };
}

// Reference pure-JS offline DSP synthesizer (mirrors AudioWorklet and C++20 native engine)
export function renderPatchSamples(patchOrId, midiNote = 60, durationSec = 1.5, options = {}) {
  const patch = resolvePatch(patchOrId);
  const sampleRate = options.sampleRate || DEFAULT_SAMPLE_RATE;
  const velocity = options.velocity ?? 0.85;
  const totalFrames = Math.max(1, Math.floor(durationSec * sampleRate));
  const releaseFrames = Math.min(Math.floor(patch.release * sampleRate), Math.floor(totalFrames * 0.4));
  const gateOffFrame = Math.max(1, totalFrames - releaseFrames);

  const left = new Float32Array(totalFrames);
  const right = new Float32Array(totalFrames);

  const baseFreq = midiToHz(midiNote);
  const detuneRatio = Math.pow(2, (patch.detuneCents || 0) / 1200);
  const incA = (baseFreq * detuneRatio) / sampleRate;
  const incB = (baseFreq / detuneRatio) / sampleRate;
  const incSub = (baseFreq * 0.5) / sampleRate;

  let phaseA = 0;
  let phaseB = 0.25;
  let phaseSub = 0;
  let fmCarPhase = 0;
  let fmModPhase = 0;

  // Granular voice state
  const table = buildGranularTable(2048);
  const tableMask = 2047;
  const MAX_GRAINS = 16;
  const grainActive = new Uint8Array(MAX_GRAINS);
  const grainPos = new Float32Array(MAX_GRAINS);
  const grainAge = new Float32Array(MAX_GRAINS);
  const grainDur = new Float32Array(MAX_GRAINS);
  const grainRate = new Float32Array(MAX_GRAINS);
  const grainPan = new Float32Array(MAX_GRAINS);
  let grainSpawnAccum = 0;
  const rng = { s: 0x1337c0de ^ ((midiNote + 1) * 2654435761) };

  // Chamberlin 2x oversampled SVF state (L + R)
  const clampedCut = Math.max(60, Math.min(patch.cutoff || 2400, sampleRate * 0.22));
  const f = Math.min(0.85, 2.0 * Math.sin((Math.PI * clampedCut) / (sampleRate * 2.0)));
  const q = Math.max(0.14, 1.0 - Math.max(0, Math.min(0.92, patch.resonance || 0.25)));
  let lpL = 0, bpL = 0;
  let lpR = 0, bpR = 0;

  // ADSR state
  const atkSec = Math.max(0.001, patch.attack || 0.01);
  const decSec = Math.max(0.005, patch.decay || 0.2);
  const susLvl = Math.max(0, Math.min(1, patch.sustain ?? 0.7));
  const relSec = Math.max(0.005, patch.release || 0.25);
  const atkStep = 1 / (atkSec * sampleRate);
  const decStep = (1 - susLvl) / (decSec * sampleRate);
  const relStep = Math.max(susLvl, 0.01) / (relSec * sampleRate);
  let envStage = 1; // 1=attack, 2=decay, 3=sustain, 4=release
  let envVal = 0;

  const drive = Math.max(0.5, patch.drive || 1.2);
  const outGain = Math.max(0.05, Math.min(1.0, (patch.gain ?? 0.75) * velocity));
  const fmDecayCoeff = Math.exp(-1 / (Math.max(0.02, patch.fmDecay || 0.4) * sampleRate));
  let fmEnv = 1.0;

  let peak = 0;

  for (let i = 0; i < totalFrames; i++) {
    if (i === gateOffFrame && envStage < 4) {
      envStage = 4;
    }

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
      if (envVal < 0) envVal = 0;
    }

    let sigL = 0;
    let sigR = 0;

    if (patch.engine === 'granular') {
      const density = Math.max(4, Math.min(80, patch.grainDensity || 24));
      grainSpawnAccum += density / sampleRate;
      if (grainSpawnAccum >= 1.0) {
        grainSpawnAccum -= 1.0;
        for (let g = 0; g < MAX_GRAINS; g++) {
          if (!grainActive[g]) {
            grainActive[g] = 1;
            grainAge[g] = 0;
            grainDur[g] = Math.max(64, Math.floor(((patch.grainSizeMs || 65) * 0.001) * sampleRate));
            grainPos[g] = nextRand(rng) * 2048;
            const scatter = (nextRand(rng) * 2 - 1) * (patch.pitchScatter || 0.15);
            const pitchMult = Math.pow(2, scatter);
            grainRate[g] = (baseFreq * pitchMult * 2048) / sampleRate;
            grainPan[g] = nextRand(rng) * 0.7 + 0.15;
            break;
          }
        }
      }

      let gSumL = 0;
      let gSumR = 0;
      let activeCount = 0;
      for (let g = 0; g < MAX_GRAINS; g++) {
        if (!grainActive[g]) continue;
        const tNorm = grainAge[g] / grainDur[g];
        if (tNorm >= 1.0) {
          grainActive[g] = 0;
          continue;
        }
        const win = 0.5 - 0.5 * Math.cos(TWO_PI * tNorm);
        const idx0 = grainPos[g] | 0;
        const frac = grainPos[g] - idx0;
        const s0 = table[idx0 & tableMask];
        const s1 = table[(idx0 + 1) & tableMask];
        const sample = (s0 + (s1 - s0) * frac) * win;
        const pan = grainPan[g];
        gSumL += sample * (1.0 - pan * 0.65);
        gSumR += sample * (0.35 + pan * 0.65);
        grainPos[g] += grainRate[g];
        grainAge[g] += 1;
        activeCount++;
      }
      const norm = activeCount > 0 ? 1 / Math.sqrt(activeCount + 1) : 1;
      sigL = gSumL * norm;
      sigR = gSumR * norm;
    } else if (patch.engine === 'fm') {
      const modFreq = baseFreq * (patch.fmRatio || 3.5);
      const modIdx = (patch.fmIndex || 4.5) * fmEnv;
      fmEnv *= fmDecayCoeff;

      const modVal = Math.sin(fmModPhase * TWO_PI) * modIdx;
      const carL = Math.sin(fmCarPhase * TWO_PI + modVal);
      const carR = Math.sin((fmCarPhase + 0.0018) * TWO_PI + modVal * 0.985);
      sigL = carL * 0.72;
      sigR = carR * 0.72;

      fmCarPhase += baseFreq / sampleRate;
      if (fmCarPhase >= 1.0) fmCarPhase -= 1.0;
      fmModPhase += modFreq / sampleRate;
      if (fmModPhase >= 1.0) fmModPhase -= 1.0;
    } else {
      // Poly-BLEP dual detuned saw + sub oscillator
      let sawA = 2.0 * phaseA - 1.0 - polyBlep(phaseA, incA);
      let sawB = 2.0 * phaseB - 1.0 - polyBlep(phaseB, incB);
      const sub = Math.sin(phaseSub * TWO_PI) * (patch.subLevel ?? 0.35);

      sigL = (sawA * 0.62 + sawB * 0.38) * 0.55 + sub * 0.45;
      sigR = (sawA * 0.38 + sawB * 0.62) * 0.55 + sub * 0.45;

      phaseA += incA;
      if (phaseA >= 1.0) phaseA -= 1.0;
      phaseB += incB;
      if (phaseB >= 1.0) phaseB -= 1.0;
      phaseSub += incSub;
      if (phaseSub >= 1.0) phaseSub -= 1.0;
    }

    // 2x oversampled Chamberlin State-Variable Resonant Low-Pass Filter
    for (let os = 0; os < 2; os++) {
      const hpL = sigL - lpL - q * bpL;
      bpL += f * hpL;
      lpL += f * bpL;

      const hpR = sigR - lpR - q * bpR;
      bpR += f * hpR;
      lpR += f * bpR;
    }

    const outL = Math.tanh(lpL * envVal * drive) * outGain;
    const outR = Math.tanh(lpR * envVal * drive) * outGain;

    left[i] = outL;
    right[i] = outR;
    const aPeak = Math.max(Math.abs(outL), Math.abs(outR));
    if (aPeak > peak) peak = aPeak;
  }

  return { left, right, sampleRate, numFrames: totalFrames, channels: 2, peak, patch };
}

export function renderPatchToWav(patchOrId, midiNote = 60, durationSec = 1.5, options = {}) {
  const start = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const rendered = renderPatchSamples(patchOrId, midiNote, durationSec, options);
  const bytes = encodeWavPcm16(rendered.left, rendered.right, rendered.sampleRate);
  const renderMs = Number(((typeof performance !== 'undefined' ? performance.now() : Date.now()) - start).toFixed(2));
  const blob = typeof Blob !== 'undefined' ? new Blob([bytes], { type: 'audio/wav' }) : null;

  return {
    bytes,
    blob,
    sampleRate: rendered.sampleRate,
    numFrames: rendered.numFrames,
    channels: rendered.channels,
    peak: rendered.peak,
    renderMs,
    patch: rendered.patch,
  };
}
