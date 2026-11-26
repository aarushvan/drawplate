// Drawplate Slewbox: Public API and Node CLI Runner

import {
  DEFAULT_SAMPLE_RATE,
  CURATED_PATCHES,
  PATCH_MAP,
  resolvePatch,
  midiToHz,
  polyBlep,
  buildGranularTable,
  encodeWavPcm16,
  parseWavHeader,
  renderPatchSamples,
  renderPatchToWav,
} from './wav.mjs';

import { SlewboxEngine } from './engine.mjs';

export {
  DEFAULT_SAMPLE_RATE,
  CURATED_PATCHES,
  PATCH_MAP,
  resolvePatch,
  midiToHz,
  polyBlep,
  buildGranularTable,
  encodeWavPcm16,
  parseWavHeader,
  renderPatchSamples,
  renderPatchToWav,
  SlewboxEngine,
};

function readFlagValue(args, flag, fallback) {
  const idx = args.indexOf(flag);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return fallback;
}

export async function runSlewboxCli(args = [], io = { log: console.log, error: console.error }) {
  const jsonFlag = args.includes('--json');
  const cmd = args[0];

  if (!cmd || cmd === '--help' || cmd === '-h') {
    io.log(
      [
        'drawplate slewbox - Modular/Granular DSP Synthesizer and 48kHz WAV Renderer',
        '',
        'Usage:',
        '  drawplate slewbox patches [--json]',
        '  drawplate slewbox render --patch saw|granular|fm|sub --note 60 --seconds 1.5 --out out.wav [--native] [--json]',
      ].join('\n')
    );
    return 0;
  }

  if (cmd === 'patches') {
    if (jsonFlag) {
      io.log(JSON.stringify(CURATED_PATCHES, null, 2));
    } else {
      io.log('Slewbox Curated Patches:');
      for (const p of CURATED_PATCHES) {
        io.log(`  ${p.id.padEnd(10)} ${p.name.padEnd(16)} engine=${p.engine.padEnd(9)} cutoff=${p.cutoff}Hz  ${p.description}`);
      }
    }
    return 0;
  }

  if (cmd === 'render') {
    const patchId = readFlagValue(args, '--patch', 'saw');
    const note = Number(readFlagValue(args, '--note', '60'));
    const seconds = Number(readFlagValue(args, '--seconds', '1.5'));
    const outPath = readFlagValue(args, '--out', 'slewbox-out.wav');
    const useNative = args.includes('--native');

    if (!PATCH_MAP[patchId]) {
      io.error(`slewbox render: unknown patch "${patchId}" (expected saw, granular, fm, or sub)`);
      return 1;
    }
    if (!Number.isFinite(note) || note < 0 || note > 127) {
      io.error(`slewbox render: invalid MIDI note "${note}" (expected 0..127)`);
      return 1;
    }
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 30) {
      io.error(`slewbox render: invalid duration "${seconds}" (expected 0.05..30 seconds)`);
      return 1;
    }

    if (useNative) {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const { fileURLToPath } = await import('node:url');
      const path = await import('node:path');
      const execFileAsync = promisify(execFile);

      const binPath = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        'native',
        'slewbox-cli'
      );
      const nativeArgs = [
        '--patch', patchId,
        '--note', String(note),
        '--seconds', String(seconds),
        '--out', outPath,
      ];
      if (jsonFlag) nativeArgs.push('--json');
      try {
        const { stdout } = await execFileAsync(binPath, nativeArgs);
        io.log(stdout.trim());
        return 0;
      } catch (err) {
        io.error(`slewbox render --native failed: ${err.message}`);
        return 1;
      }
    }

    const fs = await import('node:fs/promises');
    const rendered = renderPatchToWav(patchId, note, seconds);
    await fs.writeFile(outPath, rendered.bytes);

    const summary = {
      patch: patchId,
      note,
      sampleRate: rendered.sampleRate,
      channels: rendered.channels,
      samples: rendered.numFrames,
      bytes: rendered.bytes.byteLength,
      peak: Number(rendered.peak.toFixed(4)),
      renderMs: rendered.renderMs,
      out: outPath,
    };

    if (jsonFlag) {
      io.log(JSON.stringify(summary, null, 2));
    } else {
      io.log(
        `Rendered patch=${summary.patch} note=${summary.note} samples=${summary.samples} (${summary.sampleRate}Hz stereo PCM16, ${summary.bytes} bytes) peak=${summary.peak} in ${summary.renderMs} ms -> ${summary.out}`
      );
    }
    return 0;
  }

  io.error(`slewbox: unknown command "${cmd}" (expected patches or render)`);
  return 1;
}
