import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  SHADER_PRESETS,
  POST_SHADERS,
  FULLSCREEN_VERT_GLSL,
  getShaderPreset,
  analyzeShader,
  formatAnalysisReport,
  runSubpassCli,
  SubpassEngine,
} from '../packages/subpass/index.mjs';

test('Subpass built-in presets and post-processing shaders pass static GLSL analysis', () => {
  assert.equal(SHADER_PRESETS.length, 3);
  const allShaders = [
    ...SHADER_PRESETS,
    ...Object.values(POST_SHADERS),
  ];

  for (const shader of allShaders) {
    const result = analyzeShader(shader.source);
    assert.equal(result.ok, true, `Preset ${shader.id} failed analysis: ${JSON.stringify(result.diagnostics)}`);
    assert.equal(result.language, 'glsl');
    assert.equal(result.version, '300 es');
    assert.equal(result.stage, 'fragment');
    assert.ok(result.entryPoints.includes('main'), `${shader.id} must define main()`);
    assert.ok(result.uniforms.length >= 2, `${shader.id} should declare uniforms`);
    assert.ok(result.complexity.estimatedInstructions > 20, `${shader.id} should report positive complexity`);
  }

  // Vertex shader check
  const vertAnalysis = analyzeShader(FULLSCREEN_VERT_GLSL);
  assert.equal(vertAnalysis.ok, true);
  assert.equal(vertAnalysis.stage, 'vertex');
  assert.equal(getShaderPreset('sdf_lattice').id, 'sdf_lattice');
  assert.equal(getShaderPreset('nonexistent').id, 'pbr_sphere');
});

test('Subpass static analyzer extracts textures, uniforms, functions, and WGSL workgroup sizes', () => {
  const bloomAnalysis = analyzeShader(POST_SHADERS.bloomExtract.source);
  assert.equal(bloomAnalysis.textures.length, 1);
  assert.equal(bloomAnalysis.textures[0].name, 'u_sceneTex');
  assert.ok(bloomAnalysis.functions.some((f) => f.name === 'karisWeight'));
  assert.ok(bloomAnalysis.complexity.textureLookups >= 5);

  const wgslCompute = `
    @group(0) @binding(0) var<uniform> params: vec4<f32>;
    @group(0) @binding(1) var srcTex: texture_2d<f32>;
    @compute @workgroup_size(16, 8, 1)
    fn cs_main(@builtin(global_invocation_id) gid: vec3<u32>) {
      let c = textureLoad(srcTex, vec2<i32>(gid.xy), 0);
      let s = c.x + params.x;
    }
  `;
  const wgsl = analyzeShader(wgslCompute);
  assert.equal(wgsl.ok, true);
  assert.equal(wgsl.language, 'wgsl');
  assert.equal(wgsl.stage, 'compute');
  assert.deepEqual(wgsl.workgroupSize, [16, 8, 1]);
  assert.deepEqual(wgsl.entryPoints, ['cs_main']);
  assert.equal(wgsl.uniforms.length, 1);
  assert.equal(wgsl.textures.length, 1);
});

test('Subpass static analyzer catches unmatched braces, missing semicolons, and missing entry point', () => {
  const brokenBrace = `#version 300 es
precision highp float;
out vec4 fragColor;
void main() {
  fragColor = vec4(1.0);
`;
  const r1 = analyzeShader(brokenBrace);
  assert.equal(r1.ok, false);
  assert.ok(r1.diagnostics.some((d) => d.severity === 'error' && /Unclosed '\{'/.test(d.message)));

  const missingSemi = `#version 300 es
precision highp float;
out vec4 fragColor;
void main() {
  vec3 c = vec3(0.2, 0.7, 0.4)
  fragColor = vec4(c, 1.0);
}
`;
  const r2 = analyzeShader(missingSemi);
  assert.equal(r2.ok, false);
  assert.ok(r2.diagnostics.some((d) => d.severity === 'error' && d.line === 5 && /semicolon/i.test(d.message)));

  const noEntry = `#version 300 es
precision highp float;
float helper(float x) {
  return x * 2.0;
}
`;
  const r3 = analyzeShader(noEntry);
  assert.equal(r3.ok, false);
  assert.ok(r3.diagnostics.some((d) => d.severity === 'error' && /entry point/i.test(d.message)));
});

test('Subpass CLI handles presets, check, inspect on presets and real disk files', async () => {
  const logs = [];
  const errs = [];
  const io = {
    log: (m) => logs.push(m),
    error: (m) => errs.push(m),
  };

  const rcPresets = await runSubpassCli(['presets', '--json'], io);
  assert.equal(rcPresets, 0);
  const parsedPresets = JSON.parse(logs.pop());
  assert.equal(parsedPresets.length, 6);

  const rcCheckPreset = await runSubpassCli(['check', 'pbr_sphere'], io);
  assert.equal(rcCheckPreset, 0);
  assert.match(logs.pop(), /Subpass Shader Analysis \[OK\]/);

  // Test real file check (good + broken)
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'subpass-test-'));
  const goodFile = path.join(tmpDir, 'good.glsl');
  const badFile = path.join(tmpDir, 'bad.glsl');
  await fs.writeFile(goodFile, getShaderPreset('flow_field').source, 'utf8');
  await fs.writeFile(badFile, '#version 300 es\nvoid main() {\n  float x = 1.0\n', 'utf8');

  try {
    const rcGood = await runSubpassCli(['inspect', goodFile, '--json'], io);
    assert.equal(rcGood, 0);
    const report = JSON.parse(logs.pop());
    assert.equal(report.ok, true);
    assert.ok(report.functions.some((f) => f.name === 'curlField'));

    const rcBad = await runSubpassCli(['check', badFile], io);
    assert.equal(rcBad, 1);
    const badText = logs.pop();
    assert.match(badText, /\[FAIL\]/);
    assert.ok(formatAnalysisReport(analyzeShader(getShaderPreset('pbr_sphere').source)).includes('OK'));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('SubpassEngine supports Canvas2D graceful fallback when WebGL2 is unavailable', () => {
  const ops = [];
  const fakeCtx2d = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    fillRect: () => ops.push('fillRect'),
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    stroke: () => {},
    arc: () => {},
    fill: () => {},
    ellipse: () => {},
    save: () => {},
    restore: () => {},
    translate: () => {},
    rotate: () => {},
    createRadialGradient: () => ({ addColorStop: () => {} }),
  };
  const fakeCanvas = {
    width: 320,
    height: 180,
    getBoundingClientRect: () => ({ width: 320, height: 180, left: 0, top: 0 }),
    getContext: (kind) => (kind === '2d' ? fakeCtx2d : null),
    addEventListener: () => {},
    removeEventListener: () => {},
  };

  const engine = new SubpassEngine(fakeCanvas, { autoStart: false });
  assert.equal(engine.getStats().backend, 'canvas2d');
  engine.setPassEnabled('bloom', false);
  assert.equal(engine.getPassEnabled().bloom, false);
  engine.setUniform('exposure', 1.4);
  engine.step(0.016);
  assert.ok(ops.length > 0);
  engine.pause();
  assert.equal(engine.isPaused(), true);
  engine.destroy();
});
