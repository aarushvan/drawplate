import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_SAMPLE_RATE,
  CURATED_PATCHES,
  midiToHz,
  encodeWavPcm16,
  parseWavHeader,
  renderPatchSamples,
  renderPatchToWav,
  SlewboxEngine,
  runSlewboxCli,
} from '../packages/slewbox/index.mjs';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NATIVE_BIN = path.resolve(__dirname, '../packages/slewbox/native/slewbox-cli');

test('Slewbox offline DSP produces bounded, finite, non-silent stereo audio across all curated patches', () => {
  assert.equal(CURATED_PATCHES.length, 4);
  assert.equal(Math.round(midiToHz(69)), 440);
  assert.ok(Math.abs(midiToHz(60) - 261.6256) < 0.01);

  for (const patch of CURATED_PATCHES) {
    const res = renderPatchSamples(patch.id, 60, 0.5);
    assert.equal(res.sampleRate, DEFAULT_SAMPLE_RATE);
    assert.equal(res.numFrames, 24000);
    assert.equal(res.left.length, 24000);
    assert.equal(res.right.length, 24000);

    let maxAbs = 0;
    let rmsSum = 0;
    for (let i = 0; i < res.numFrames; i++) {
      const l = res.left[i];
      const r = res.right[i];
      assert.ok(Number.isFinite(l) && Number.isFinite(r), `Non-finite sample in patch ${patch.id} at frame ${i}`);
      assert.ok(Math.abs(l) <= 1.0 && Math.abs(r) <= 1.0, `Sample clipping in patch ${patch.id} at frame ${i}`);
      maxAbs = Math.max(maxAbs, Math.abs(l), Math.abs(r));
      rmsSum += l * l + r * r;
    }
    const rms = Math.sqrt(rmsSum / (res.numFrames * 2));
    assert.ok(maxAbs > 0.05, `Patch ${patch.id} produced near-silent peak ${maxAbs}`);
    assert.ok(rms > 0.01, `Patch ${patch.id} produced near-silent RMS ${rms}`);
  }
});

test('Slewbox PCM16 RIFF WAV encoder produces spec-compliant 48 kHz stereo headers and payload', () => {
  const rendered = renderPatchToWav('fm', 64, 0.25);
  const header = parseWavHeader(rendered.bytes);

  assert.equal(header.valid, true);
  assert.equal(header.riff, 'RIFF');
  assert.equal(header.wave, 'WAVE');
  assert.equal(header.audioFormat, 1);
  assert.equal(header.channels, 2);
  assert.equal(header.sampleRate, 48000);
  assert.equal(header.bitsPerSample, 16);
  assert.equal(header.blockAlign, 4);
  assert.equal(header.byteRate, 192000);
  assert.equal(header.numFrames, 12000);
  assert.equal(header.dataSize, 12000 * 4);
  assert.equal(rendered.bytes.byteLength, 44 + 12000 * 4);

  // Verify mono encoding works as well
  const mono = encodeWavPcm16(new Float32Array([0, 0.5, -0.5, 1.0]), null, 48000);
  const monoHeader = parseWavHeader(mono);
  assert.equal(monoHeader.valid, true);
  assert.equal(monoHeader.channels, 1);
  assert.equal(monoHeader.numFrames, 4);
});

test('SlewboxEngine patch serialization and offline WAV rendering work cleanly without AudioContext', () => {
  const engine = new SlewboxEngine({ patch: 'granular' });
  assert.equal(engine.getPatch().id, 'granular');
  engine.setParam('cutoff', 4100);
  assert.equal(engine.getPatch().cutoff, 4100);

  const json = engine.exportPatchJson();
  const engine2 = new SlewboxEngine({ patch: 'saw' });
  engine2.importPatchJson(json);
  assert.equal(engine2.getPatch().engine, 'granular');
  assert.equal(engine2.getPatch().cutoff, 4100);

  const wav = engine2.renderPatchToWav(null, 62, 0.2);
  const hdr = parseWavHeader(wav.bytes);
  assert.equal(hdr.valid, true);
  assert.equal(hdr.numFrames, 9600);
});

test('Slewbox compiled C++20 native CLI renders valid 48 kHz stereo PCM16 WAV files for saw, granular, and fm', async () => {
  const stat = await fs.stat(NATIVE_BIN);
  assert.ok(stat.size > 10000, 'Compiled C++20 slewbox-cli binary should exist and be non-empty');

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'slewbox-native-test-'));
  try {
    for (const patchId of ['saw', 'granular', 'fm']) {
      const outFile = path.join(tmpDir, `${patchId}.wav`);
      const { stdout } = await execFileAsync(NATIVE_BIN, [
        '--patch', patchId,
        '--note', '60',
        '--seconds', '0.5',
        '--out', outFile,
        '--json',
      ]);

      const report = JSON.parse(stdout);
      assert.equal(report.patch, patchId);
      assert.equal(report.sampleRate, 48000);
      assert.equal(report.channels, 2);
      assert.equal(report.samples, 24000);
      assert.ok(report.peak > 0.05 && report.peak <= 1.0, `Unexpected peak ${report.peak} for ${patchId}`);
      assert.ok(report.renderMs >= 0 && report.renderMs < 5000);

      const diskBytes = new Uint8Array(await fs.readFile(outFile));
      const hdr = parseWavHeader(diskBytes);
      assert.equal(hdr.valid, true, `Native WAV header invalid for ${patchId}`);
      assert.equal(hdr.sampleRate, 48000);
      assert.equal(hdr.channels, 2);
      assert.equal(hdr.bitsPerSample, 16);
      assert.equal(hdr.numFrames, 24000);
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('Slewbox Node CLI supports patches and render (JS and --native)', async () => {
  const logs = [];
  const errs = [];
  const io = {
    log: (m) => logs.push(m),
    error: (m) => errs.push(m),
  };

  const rcPatches = await runSlewboxCli(['patches', '--json'], io);
  assert.equal(rcPatches, 0);
  const list = JSON.parse(logs.pop());
  assert.equal(list.length, 4);

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'slewbox-cli-test-'));
  try {
    const outJs = path.join(tmpDir, 'js.wav');
    const rcJs = await runSlewboxCli(['render', '--patch', 'saw', '--note', '60', '--seconds', '0.25', '--out', outJs, '--json'], io);
    assert.equal(rcJs, 0);
    const jsMeta = JSON.parse(logs.pop());
    assert.equal(jsMeta.samples, 12000);
    assert.equal(parseWavHeader(new Uint8Array(await fs.readFile(outJs))).valid, true);

    const outNative = path.join(tmpDir, 'native.wav');
    const rcNat = await runSlewboxCli(['render', '--patch', 'fm', '--note', '67', '--seconds', '0.25', '--out', outNative, '--native', '--json'], io);
    assert.equal(rcNat, 0);
    const natMeta = JSON.parse(logs.pop());
    assert.equal(natMeta.samples, 12000);
    assert.equal(parseWavHeader(new Uint8Array(await fs.readFile(outNative))).valid, true);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
