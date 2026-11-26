// Drawplate Interactive Workbench Controller
// Wires all 5 real tools: Subpass (WebGL2), Cleave (AST diff/merge), Cadastre (Hybrid Search + Call Graph),
// Slewbox (Web AudioWorklet DSP Synth), and Tapeline (HTTP Cassette Waterfall & Schema Diff).

import { SubpassEngine } from './packages/subpass/profiler.mjs';
import { SHADER_PRESETS, getShaderPreset } from './packages/subpass/shaders.mjs';
import { analyzeShader } from './packages/subpass/analyzer.mjs';
import { diffAst, diffLines, merge3 } from './packages/cleave/index.mjs';
import { prepareIndex, searchIndex, traceCallers, traceCallees } from './packages/cadastre/search.mjs';
import { SlewboxEngine, CURATED_PATCHES, renderPatchToWav } from './packages/slewbox/engine.mjs';
import { parseCassette, computeWaterfall, diffCassettes } from './packages/tapeline/cassette.mjs';

const TOOLS = ['subpass', 'cleave', 'cadastre', 'slewbox', 'tapeline'];
let activeTool = 'subpass';
let isLocalServer = false;
const localServerProbe = probeLocalServer();

// ==================== SHARED UTILITIES ====================
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isTypingElement(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copyText(text, btnEl, doneLabel = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  if (btnEl) {
    const orig = btnEl.textContent;
    btnEl.textContent = doneLabel;
    setTimeout(() => { btnEl.textContent = orig; }, 1400);
  }
}

// ==================== APP SHELL & ROUTING ====================
async function probeLocalServer() {
  const statusEl = document.getElementById('wb-runtime-status');
  const labelEl = document.getElementById('wb-runtime-label');
  if (window.location.protocol === 'file:' || window.location.hostname.endsWith('.github.io')) {
    if (labelEl) labelEl.textContent = 'Browser Mode (Offline)';
    return;
  }
  try {
    const res = await fetch('./api/health', { cache: 'no-store', signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      const data = await res.json();
      if (data?.name === 'drawplate' && data.ok === true) {
        isLocalServer = true;
        statusEl?.classList.add('is-local');
        if (labelEl) labelEl.textContent = 'Local Server (Live Repo)';
        return;
      }
    }
  } catch {
    // Static browser mode
  }
  if (labelEl) labelEl.textContent = 'Browser Mode (Offline)';
}

function activateTool(toolName, updateHash = true) {
  const next = TOOLS.includes(toolName) ? toolName : 'subpass';
  activeTool = next;

  document.querySelectorAll('.wb-tab').forEach((btn) => {
    const on = btn.dataset.tool === next;
    btn.classList.toggle('is-active', on);
    btn.setAttribute('aria-selected', String(on));
  });

  document.querySelectorAll('.wb-view').forEach((sec) => {
    const on = sec.dataset.view === next;
    sec.hidden = !on;
    sec.classList.toggle('is-active', on);
  });

  if (updateHash && window.location.hash !== `#${next}`) {
    history.replaceState(null, '', `#${next}`);
  }

  // Tool lifecycle hooks
  if (next === 'subpass') {
    if (subpassState.engine && !subpassState.userPaused) {
      subpassState.engine.resume();
    }
    subpassState.engine?.resize();
  } else {
    subpassState.engine?.pause();
  }

  if (next === 'cleave' && !cleaveState.initialized) {
    initCleave();
  } else if (next === 'cadastre' && !cadastreState.initialized) {
    initCadastre();
  } else if (next === 'slewbox' && !slewboxState.initialized) {
    initSlewbox();
  } else if (next === 'tapeline' && !tapelineState.initialized) {
    initTapeline();
  }
}

function setupShellNavigation() {
  document.querySelectorAll('.wb-tab').forEach((btn) => {
    btn.addEventListener('click', () => activateTool(btn.dataset.tool));
  });

  window.addEventListener('hashchange', () => {
    const hash = window.location.hash.replace(/^#/, '').toLowerCase();
    if (TOOLS.includes(hash) && hash !== activeTool) {
      activateTool(hash, false);
    }
  });

  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || isTypingElement(e.target)) return;
    const num = Number(e.key);
    if (num >= 1 && num <= 5) {
      e.preventDefault();
      activateTool(TOOLS[num - 1]);
    }
  });
}

// ==================== TOOL 1: SUBPASS ====================
const subpassState = {
  engine: null,
  userPaused: false,
  presetId: 'pbr_sphere',
  compileTimer: null,
};

function renderSubpassGutter(source, errorLines = new Set()) {
  const gutter = document.getElementById('sp-gutter');
  if (!gutter) return;
  const count = source.split('\n').length;
  const html = [];
  for (let i = 1; i <= count; i++) {
    const cls = errorLines.has(i) ? 'wb-gutter-line is-err' : 'wb-gutter-line';
    html.push(`<span class="${cls}">${i}</span>`);
  }
  gutter.innerHTML = html.join('');
}

function updateSubpassAnalysis(source) {
  try {
    const res = analyzeShader(source);
    document.getElementById('sp-an-uniforms').textContent = String(res.uniforms.length);
    document.getElementById('sp-an-funcs').textContent = String(res.functions.length);
    document.getElementById('sp-an-ops').textContent = `~${res.complexity.estimatedInstructions}`;
    document.getElementById('sp-an-branches').textContent = String(res.complexity.branches);
  } catch {
    // Ignore transient edits
  }
}

function renderSubpassCompileResult(result, source) {
  const diagEl = document.getElementById('sp-diagnostics');
  const statusEl = document.getElementById('sp-compile-status');
  const msEl = document.getElementById('sp-compile-ms');
  const errLines = new Set((result.errors || []).map((e) => e.line));

  renderSubpassGutter(source, errLines);
  if (msEl) msEl.textContent = `${Number(result.compileMs || 0).toFixed(2)} ms`;

  if (result.ok) {
    if (statusEl) statusEl.textContent = `Compiled (${Number(result.compileMs || 0).toFixed(1)} ms)`;
    if (diagEl) diagEl.innerHTML = `<span class="wb-diag-ok">0 compile errors. Live FBO pipeline updated in ${Number(result.compileMs || 0).toFixed(2)} ms.</span>`;
  } else {
    if (statusEl) statusEl.textContent = `${result.errors.length} error(s)`;
    if (diagEl) {
      diagEl.innerHTML = result.errors
        .map((err) => `<span class="wb-diag-err">Line ${err.line}: ${escapeHtml(err.message)}</span>`)
        .join('');
    }
  }
}

function updateSubpassStats(stats) {
  const fpsEl = document.getElementById('sp-fps');
  const frameEl = document.getElementById('sp-frame-ms');
  const backendEl = document.getElementById('sp-backend');
  const hudRes = document.getElementById('sp-hud-res');
  const hudPasses = document.getElementById('sp-hud-passes');

  if (fpsEl) fpsEl.textContent = stats.fps.toFixed(1);
  if (frameEl) frameEl.textContent = `${stats.frameMs.toFixed(2)} ms`;
  if (backendEl) backendEl.textContent = stats.backend === 'webgl2' ? `WebGL2 ${stats.fboFormat}` : 'Canvas2D';
  if (hudRes && stats.resolution) hudRes.textContent = `${stats.resolution.width}x${stats.resolution.height} · ${stats.timerMode}`;

  const enabled = subpassState.engine?.getPassEnabled() || { geometry: true, bloom: true, tonemap: true };
  const activeCount = Object.values(enabled).filter(Boolean).length;
  if (hudPasses) hudPasses.textContent = `${activeCount}/3 passes active`;

  const budget = 16.67;
  for (const key of ['geometry', 'bloom', 'tonemap']) {
    const val = enabled[key] ? Number(stats.passes?.[key] || 0) : 0;
    const msOut = document.getElementById(`sp-ms-${key}`);
    const barOut = document.getElementById(`sp-bar-${key}`);
    if (msOut) msOut.textContent = `${val.toFixed(2)} ms`;
    if (barOut) {
      const pct = Math.min(100, Math.max(val > 0 ? 4 : 0, (val / budget) * 100 * 3.5));
      barOut.style.width = `${pct.toFixed(1)}%`;
    }
  }
}

function initSubpass() {
  const canvas = document.getElementById('sp-canvas');
  const editor = document.getElementById('sp-editor');
  const gutter = document.getElementById('sp-gutter');
  const presetSelect = document.getElementById('sp-preset');
  if (!canvas || !editor) return;

  // Populate presets from shaders.mjs
  if (presetSelect) {
    presetSelect.innerHTML = SHADER_PRESETS
      .map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.filename)} (${escapeHtml(p.name)})</option>`)
      .join('');
  }

  const initialPreset = getShaderPreset(subpassState.presetId);
  editor.value = initialPreset.source;
  document.getElementById('sp-filename').textContent = `shaders/${initialPreset.filename}`;
  renderSubpassGutter(initialPreset.source);
  updateSubpassAnalysis(initialPreset.source);

  subpassState.engine = new SubpassEngine(canvas, {
    presetId: subpassState.presetId,
    autoStart: true,
    onStats: updateSubpassStats,
    onCompile: (res) => renderSubpassCompileResult(res, editor.value),
  });

  // Sync gutter scroll
  editor.addEventListener('scroll', () => {
    if (gutter) gutter.scrollTop = editor.scrollTop;
  });

  // Live hot-reload on edit
  editor.addEventListener('input', () => {
    renderSubpassGutter(editor.value);
    updateSubpassAnalysis(editor.value);
    clearTimeout(subpassState.compileTimer);
    subpassState.compileTimer = setTimeout(() => {
      subpassState.engine.compileUserShader(editor.value);
    }, 180);
  });

  // Preset switch
  presetSelect?.addEventListener('change', () => {
    const preset = getShaderPreset(presetSelect.value);
    subpassState.presetId = preset.id;
    editor.value = preset.source;
    document.getElementById('sp-filename').textContent = `shaders/${preset.filename}`;
    updateSubpassAnalysis(preset.source);
    subpassState.engine.setPreset(preset.id);
  });

  // Buttons
  const playBtn = document.getElementById('sp-toggle-play');
  playBtn?.addEventListener('click', () => {
    subpassState.userPaused = !subpassState.userPaused;
    if (subpassState.userPaused) {
      subpassState.engine.pause();
      playBtn.textContent = 'Play';
    } else {
      subpassState.engine.resume();
      playBtn.textContent = 'Pause';
    }
  });

  document.getElementById('sp-recompile')?.addEventListener('click', () => {
    subpassState.engine.compileUserShader(editor.value);
  });

  document.getElementById('sp-reset')?.addEventListener('click', () => {
    const preset = getShaderPreset(subpassState.presetId);
    editor.value = preset.source;
    updateSubpassAnalysis(preset.source);
    subpassState.engine.compileUserShader(preset.source);
  });

  // Pass toggle switches
  for (const pass of ['geometry', 'bloom', 'tonemap']) {
    const cb = document.getElementById(`sp-pass-${pass}`);
    cb?.addEventListener('change', () => {
      subpassState.engine.setPassEnabled(pass, cb.checked);
    });
  }

  // Uniform sliders
  const uniformBindings = [
    ['sp-u-threshold', 'sp-v-threshold', 'bloomThreshold', (v) => v.toFixed(2)],
    ['sp-u-intensity', 'sp-v-intensity', 'bloomIntensity', (v) => v.toFixed(2)],
    ['sp-u-exposure', 'sp-v-exposure', 'exposure', (v) => v.toFixed(2)],
    ['sp-u-speed', 'sp-v-speed', 'speed', (v) => `${v.toFixed(2)}x`],
  ];
  for (const [inId, outId, uName, fmt] of uniformBindings) {
    const input = document.getElementById(inId);
    const out = document.getElementById(outId);
    input?.addEventListener('input', () => {
      const val = Number(input.value);
      if (out) out.textContent = fmt(val);
      subpassState.engine.setUniform(uName, val);
    });
  }

  window.addEventListener('resize', () => {
    if (activeTool === 'subpass') subpassState.engine?.resize();
  });
}

// ==================== TOOL 2: CLEAVE ====================
const CLEAVE_PRESETS = {
  js_move: {
    mode: 'ast',
    lang: 'js',
    base: `export function formatLatency(ms) {
  return ms.toFixed(2) + ' ms';
}

export function encodeRenderPass(encoder, pass) {
  const label = pass.name;
  const bindGroup = pass.device.createBindGroup(pass.layout);
  const rp = encoder.beginRenderPass({ label });
  rp.setPipeline(pass.pipeline);
  rp.setBindGroup(0, bindGroup);
  rp.draw(pass.vertexCount);
  rp.end();
}

export function buildFrameGraph(passes) {
  return passes.filter((p) => p.enabled);
}`,
    left: `export function formatLatency(ms) {
  return ms.toFixed(2) + ' ms';
}

export function encodeRenderPass(encoder, pass) {
  const label = pass.name;
  const bindGroup = pass.device.createBindGroup(pass.layout);
  const rp = encoder.beginRenderPass({ label });
  rp.setPipeline(pass.pipeline);
  rp.setBindGroup(0, bindGroup);
  rp.draw(pass.vertexCount);
  rp.end();
}

export function buildFrameGraph(passes) {
  return passes.filter((p) => p.enabled);
}`,
    right: `export function buildFrameGraph(passes) {
  return passes.filter((p) => p.enabled);
}

export function formatLatency(ms) {
  return ms.toFixed(2) + ' ms';
}

export function encodeRenderPass(encoder, pass) {
  const label = pass.name;
  const bindGroup = pass.cache.getOrInsert(pass.hash);
  const rp = encoder.beginRenderPass({ label, timestampWrites: pass.ts });
  rp.setPipeline(pass.pipeline);
  rp.setBindGroup(0, bindGroup);
  rp.draw(pass.vertexCount);
  pass.metrics.record(label, pass.vertexCount);
  rp.end();
}`,
  },
  rust_move: {
    mode: 'ast',
    lang: 'rust',
    base: `pub fn quantize_i8(vec: &[f32]) -> Vec<i8> {
    vec.iter().map(|v| (v * 127.0).clamp(-127.0, 127.0) as i8).collect()
}

pub fn encode_pass(enc: &mut Encoder, pass: &RenderPass) {
    let group = pass.device.create_bind_group(&pass.layout);
    let mut rp = enc.begin_pass(None);
    rp.set_pipeline(&pass.pipeline);
    rp.set_bind_group(0, &group);
    rp.draw_indexed(0..pass.indices);
}

pub fn flush_queue(queue: &Queue) {
    queue.submit_pending();
}`,
    left: `pub fn quantize_i8(vec: &[f32]) -> Vec<i8> {
    vec.iter().map(|v| (v * 127.0).clamp(-127.0, 127.0) as i8).collect()
}

pub fn encode_pass(enc: &mut Encoder, pass: &RenderPass) {
    let group = pass.device.create_bind_group(&pass.layout);
    let mut rp = enc.begin_pass(None);
    rp.set_pipeline(&pass.pipeline);
    rp.set_bind_group(0, &group);
    rp.draw_indexed(0..pass.indices);
}

pub fn flush_queue(queue: &Queue) {
    queue.submit_pending();
}`,
    right: `pub fn flush_queue(queue: &Queue) {
    queue.submit_pending();
}

pub fn quantize_i8(vec: &[f32]) -> Vec<i8> {
    vec.iter().map(|v| (v * 127.0).clamp(-127.0, 127.0) as i8).collect()
}

pub fn encode_pass(enc: &mut Encoder, pass: &RenderPass) {
    let group = pass.cache.get_or_insert(pass.hash);
    let mut rp = enc.begin_pass(Some(pass.timestamps));
    rp.set_pipeline(&pass.pipeline);
    rp.set_bind_group(0, &group);
    rp.draw_indexed(0..pass.indices);
}`,
  },
  py_move: {
    mode: 'ast',
    lang: 'python',
    base: `def normalize_scores(scores):
    peak = max(scores) if scores else 1.0
    return [s / peak for s in scores]

def rank_hybrid(vec_score, bm25_score, graph_boost):
    base = 0.55 * vec_score + 0.35 * bm25_score
    return round(base + 0.10 * graph_boost, 4)

def format_hit(sym, score):
    return f"{sym.file}:{sym.line} ({score})"`,
    left: `def normalize_scores(scores):
    peak = max(scores) if scores else 1.0
    return [s / peak for s in scores]

def rank_hybrid(vec_score, bm25_score, graph_boost):
    base = 0.55 * vec_score + 0.35 * bm25_score
    return round(base + 0.10 * graph_boost, 4)

def format_hit(sym, score):
    return f"{sym.file}:{sym.line} ({score})"`,
    right: `def format_hit(sym, score):
    return f"{sym.file}:{sym.line} ({score})"

def normalize_scores(scores):
    peak = max(scores) if scores else 1.0
    return [s / peak for s in scores]

def rank_hybrid(vec_score, bm25_score, graph_boost):
    base = 0.50 * vec_score + 0.35 * bm25_score
    return round(base + 0.15 * graph_boost, 4)`,
  },
  merge_auto: {
    mode: 'merge',
    lang: 'js',
    base: `export function computeBudget(frameMs) {
  return Math.max(0, 16.67 - frameMs);
}

export function processBlock(samples, gain) {
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    out[i] = samples[i] * gain;
  }
  return out;
}

export function clampUnit(x) {
  return Math.max(-1, Math.min(1, x));
}`,
    left: `export function clampUnit(x) {
  return Math.max(-1, Math.min(1, x));
}

export function computeBudget(frameMs) {
  return Math.max(0, 16.67 - frameMs);
}

export function processBlock(samples, gain) {
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    out[i] = samples[i] * gain;
  }
  return out;
}`,
    right: `export function computeBudget(frameMs) {
  return Math.max(0, 16.67 - frameMs);
}

export function processBlock(samples, gain) {
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    out[i] = Math.tanh(samples[i] * gain);
  }
  return out;
}

export function clampUnit(x) {
  return Math.max(-1, Math.min(1, x));
}`,
  },
  merge_conflict: {
    mode: 'merge',
    lang: 'js',
    base: `export function selectThreshold(luma) {
  const knee = 0.5;
  return luma > 0.72 ? luma * knee : 0.0;
}`,
    left: `export function selectThreshold(luma) {
  const knee = 0.45;
  return luma > 0.65 ? luma * knee : 0.0;
}`,
    right: `export function selectThreshold(luma) {
  const knee = 0.60;
  return luma > 0.80 ? luma * knee : 0.0;
}`,
  },
};

const cleaveState = {
  initialized: false,
  mode: 'ast',
  lang: 'js',
  lastOutputText: '',
};

function updateCleaveLayoutMode() {
  const inputsGrid = document.getElementById('cl-inputs-grid');
  const basePane = document.getElementById('cl-pane-base');
  const leftLabel = document.getElementById('cl-left-label');
  const rightLabel = document.getElementById('cl-right-label');
  const isMerge = cleaveState.mode === 'merge';

  if (basePane) basePane.hidden = !isMerge;
  inputsGrid?.classList.toggle('is-3way', isMerge);
  if (leftLabel) leftLabel.textContent = isMerge ? 'Left (Branch A)' : 'Before (Source A)';
  if (rightLabel) rightLabel.textContent = isMerge ? 'Right (Branch B)' : 'After (Source B)';

  document.querySelectorAll('[data-cl-mode]').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.clMode === cleaveState.mode);
  });
}

function renderDiffOpsHtml(ops) {
  if (!ops || ops.length === 0) {
    return '<div class="wb-diff-line"><span class="wb-diff-line__n"></span><span class="wb-diff-line__n"></span><span class="wb-diff-line__sig"></span><span>No differences detected.</span></div>';
  }
  return ops.map((op) => {
    const kind = op.type || op.kind || 'equal';
    let cls = 'wb-diff-line';
    let sig = ' ';
    if (kind === 'insert' || kind === 'add' || kind === '+') { cls += ' is-add'; sig = '+'; }
    else if (kind === 'delete' || kind === 'del' || kind === '-') { cls += ' is-del'; sig = '-'; }
    else if (kind === 'move' || kind === 'moved') { cls += ' is-move'; sig = 'M'; }
    else if (kind === 'hunk') { cls += ' is-hunk'; sig = '@'; }
    else if (kind === 'conflict') { cls += ' is-conflict'; sig = '!'; }
    const oldN = op.oldLine ?? op.aLine ?? '';
    const newN = op.newLine ?? op.bLine ?? '';
    const text = op.line ?? op.text ?? '';
    return `<div class="${cls}"><span class="wb-diff-line__n">${oldN}</span><span class="wb-diff-line__n">${newN}</span><span class="wb-diff-line__sig">${sig}</span><span>${escapeHtml(text)}</span></div>`;
  }).join('');
}

async function runCleave() {
  const baseEl = document.getElementById('cl-base');
  const leftEl = document.getElementById('cl-left');
  const rightEl = document.getElementById('cl-right');
  const movesStrip = document.getElementById('cl-moves-strip');
  const outEl = document.getElementById('cl-diff-output');
  const outTitle = document.getElementById('cl-out-title');
  const outBadge = document.getElementById('cl-out-badge');

  const base = baseEl.value;
  const left = leftEl.value;
  const right = rightEl.value;
  document.getElementById('cl-base-lines').textContent = `${base.split('\n').length} lines`;
  document.getElementById('cl-left-lines').textContent = `${left.split('\n').length} lines`;
  document.getElementById('cl-right-lines').textContent = `${right.split('\n').length} lines`;

  const t0 = performance.now();
  if (cleaveState.mode === 'merge') {
    const res = merge3(base, left, right, cleaveState.lang);
    const elapsed = res.stats?.elapsedMs ?? (performance.now() - t0);
    const mergedText = res.merged ?? '';
    const conflicts = res.conflicts?.length ?? 0;
    const autoMoves = res.reconciledMoves?.length ?? res.stats?.reconciledMoves ?? 0;

    document.getElementById('cl-stat-moves').textContent = String(autoMoves);
    document.getElementById('cl-stat-saved').textContent = `${res.stats?.autoMergedBlocks ?? 0} blk`;
    document.getElementById('cl-stat-conflicts').textContent = String(conflicts);
    document.getElementById('cl-stat-ms').textContent = `${Number(elapsed).toFixed(2)} ms`;

    if (outTitle) outTitle.textContent = '3-Way Structural AST Merge Result';
    if (outBadge) {
      outBadge.className = conflicts === 0 ? 'wb-badge wb-badge--ok' : 'wb-badge wb-badge--warn';
      outBadge.textContent = conflicts === 0 ? '0 conflicts (auto-reconciled)' : `${conflicts} conflict(s)`;
    }

    if (movesStrip) {
      movesStrip.innerHTML = (res.reconciledMoves || []).map((rm) => (
        `<span class="wb-move-pill">AUTO-MERGED <b>${escapeHtml(rm.symbol)}</b> moved by ${escapeHtml(rm.movedBy)}, edited by ${escapeHtml(rm.editedBy)} (L${rm.fromLine} -> L${rm.toLine})</span>`
      )).join('');
    }

    cleaveState.lastOutputText = mergedText;
    const lines = mergedText.split('\n').map((line, idx) => {
      const isConflictMarker = /^(<{7}|={7}|>{7})/.test(line);
      return {
        type: isConflictMarker ? 'conflict' : 'equal',
        oldLine: '',
        newLine: idx + 1,
        line,
      };
    });
    outEl.innerHTML = renderDiffOpsHtml(lines);
    return;
  }

  if (cleaveState.mode === 'line') {
    const lineRes = diffLines(left, right);
    const elapsed = lineRes.stats?.elapsedMs ?? (performance.now() - t0);
    const ops = lineRes.ops || [];
    const churn = (lineRes.stats?.added ?? 0) + (lineRes.stats?.removed ?? 0);

    document.getElementById('cl-stat-moves').textContent = '0';
    document.getElementById('cl-stat-saved').textContent = '0';
    document.getElementById('cl-stat-conflicts').textContent = '0';
    document.getElementById('cl-stat-ms').textContent = `${Number(elapsed).toFixed(2)} ms`;

    if (outTitle) outTitle.textContent = 'Myers Line Diff (No Move Detection)';
    if (outBadge) {
      outBadge.className = 'wb-badge wb-badge--warn';
      outBadge.textContent = `${churn} raw churn lines (+${lineRes.stats?.added ?? 0} -${lineRes.stats?.removed ?? 0})`;
    }
    if (movesStrip) movesStrip.innerHTML = '';

    cleaveState.lastOutputText = ops.map((o) => {
      const p = o.type === 'insert' ? '+' : o.type === 'delete' ? '-' : ' ';
      return `${p} ${o.line}`;
    }).join('\n');
    outEl.innerHTML = renderDiffOpsHtml(ops);
    return;
  }

  // AST Move Diff mode
  const astRes = diffAst(left, right, cleaveState.lang);
  const elapsed = astRes.stats?.elapsedMs ?? (performance.now() - t0);
  const moves = astRes.moves || [];
  const linesSaved = astRes.stats?.linesSaved ?? 0;

  document.getElementById('cl-stat-moves').textContent = String(moves.length);
  document.getElementById('cl-stat-saved').textContent = String(linesSaved);
  document.getElementById('cl-stat-conflicts').textContent = '0';
  document.getElementById('cl-stat-ms').textContent = `${Number(elapsed).toFixed(2)} ms`;

  if (outTitle) outTitle.textContent = 'Structural AST Move Diff';
  if (outBadge) {
    outBadge.className = 'wb-badge wb-badge--ok';
    outBadge.textContent = `${moves.length} moved block(s) · ${linesSaved} churn lines eliminated`;
  }

  if (movesStrip) {
    movesStrip.innerHTML = moves.map((m) => {
      const sim = m.exact ? 'exact' : `${Math.round(m.similarity * 100)}% match`;
      const inner = Array.isArray(m.innerEdits) ? m.innerEdits.length : 0;
      return `<span class="wb-move-pill">MOVE <b>${escapeHtml(m.symbol)}</b> L${m.fromLine} -> L${m.toLine} (${sim}, ${inner} inner edit line(s))</span>`;
    }).join('');
  }

  // Build readable structural diff rows from moved blocks + residual hunks
  const displayOps = [];
  for (const m of moves) {
    displayOps.push({
      type: 'hunk',
      oldLine: m.fromLine,
      newLine: m.toLine,
      line: `MOVED ${m.kind} ${m.symbol}: L${m.fromLine}-L${m.fromEndLine} -> L${m.toLine}-L${m.toEndLine} (${m.exact ? 'exact' : `${Math.round(m.similarity * 100)}% match`})`,
    });
    if (Array.isArray(m.innerEdits) && m.innerEdits.length > 0) {
      for (const ed of m.innerEdits) {
        displayOps.push({
          type: ed.type,
          oldLine: ed.oldLine ?? '',
          newLine: ed.newLine ?? '',
          line: ed.line,
        });
      }
    } else {
      displayOps.push({
        type: 'move',
        oldLine: m.fromLine,
        newLine: m.toLine,
        line: `  // ${m.lineCount} identical lines relocated with 0 inner edits`,
      });
    }
  }

  for (const h of astRes.hunks || []) {
    displayOps.push({
      type: 'hunk',
      oldLine: '',
      newLine: '',
      line: `@@ -${h.oldStart},${h.oldCount} +${h.newStart},${h.newCount} @@`,
    });
    for (const ln of h.lines || []) {
      displayOps.push(ln);
    }
  }

  cleaveState.lastOutputText = displayOps.map((o) => {
    const p = o.type === 'insert' ? '+' : o.type === 'delete' ? '-' : o.type === 'move' ? 'M' : o.type === 'hunk' ? '@' : ' ';
    return `${p} ${o.line}`;
  }).join('\n');
  outEl.innerHTML = renderDiffOpsHtml(displayOps);
}

function loadCleavePreset(presetKey) {
  const p = CLEAVE_PRESETS[presetKey] || CLEAVE_PRESETS.js_move;
  cleaveState.mode = p.mode;
  cleaveState.lang = p.lang;
  document.getElementById('cl-lang').value = p.lang;
  document.getElementById('cl-base').value = p.base;
  document.getElementById('cl-left').value = p.left;
  document.getElementById('cl-right').value = p.right;
  updateCleaveLayoutMode();
  runCleave();
}

function initCleave() {
  cleaveState.initialized = true;

  document.querySelectorAll('[data-cl-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      cleaveState.mode = btn.dataset.clMode;
      updateCleaveLayoutMode();
      runCleave();
    });
  });

  document.getElementById('cl-lang')?.addEventListener('change', (e) => {
    cleaveState.lang = e.target.value;
    runCleave();
  });

  document.getElementById('cl-preset')?.addEventListener('change', (e) => {
    loadCleavePreset(e.target.value);
  });

  let debounce = null;
  for (const id of ['cl-base', 'cl-left', 'cl-right']) {
    document.getElementById(id)?.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(runCleave, 120);
    });
  }

  document.getElementById('cl-copy-output')?.addEventListener('click', (e) => {
    copyText(cleaveState.lastOutputText, e.currentTarget);
  });

  loadCleavePreset('js_move');
}

// ==================== TOOL 3: CADASTRE ====================
const cadastreState = {
  initialized: false,
  mode: 'hybrid',
  preparedIndex: null,
  hits: [],
  selectedIndex: 0,
};

async function loadCadastreAssets() {
  await localServerProbe;
  const sourceNote = document.getElementById('cd-corpus-source');
  let hasLiveStats = false;
  if (isLocalServer) {
    try {
      const statsRes = await fetch('./api/cadastre/stats', { cache: 'no-store' });
      if (statsRes.ok) {
        const stats = await statsRes.json();
        document.getElementById('cd-stat-files').textContent = String(stats.files ?? stats.fileCount ?? 0);
        document.getElementById('cd-stat-syms').textContent = String(stats.symbols ?? stats.symbolCount ?? 0);
        document.getElementById('cd-stat-edges').textContent = String(stats.edges ?? stats.edgeCount ?? 0);
        hasLiveStats = true;
        if (sourceNote) sourceNote.textContent = 'Source: Live SQLite API (/api/cadastre)';
      }
    } catch {
      // Fall back to snapshot
    }
  }

  if (!cadastreState.preparedIndex) {
    try {
      const res = await fetch('./data/cadastre-snapshot.json', { cache: 'no-store' });
      if (res.ok) {
        const snap = await res.json();
        cadastreState.preparedIndex = prepareIndex(snap);
        if (!hasLiveStats) {
          document.getElementById('cd-stat-files').textContent = String(snap.stats?.files ?? snap.files?.length ?? 0);
          document.getElementById('cd-stat-syms').textContent = String(snap.stats?.symbols ?? snap.symbols?.length ?? 0);
          document.getElementById('cd-stat-edges').textContent = String(snap.stats?.edges ?? snap.edges?.length ?? 0);
          if (sourceNote) sourceNote.textContent = 'Source: Bundled Drawplate Snapshot (data/cadastre-snapshot.json)';
        }
      }
    } catch {
      if (sourceNote && !hasLiveStats) sourceNote.textContent = 'The bundled code index could not be loaded.';
    }
  }
}

function renderCadastreGraphSvg(centerName, callers, callees) {
  const wrap = document.getElementById('cd-graph-svg-wrap');
  const lists = document.getElementById('cd-graph-lists');
  const counts = document.getElementById('cd-graph-counts');
  if (!wrap) return;

  const uniqueCallers = [...new Set(callers.map((c) => (typeof c === 'string' ? c : (c.caller || c.name || c.symbol))))].slice(0, 6);
  const uniqueCallees = [...new Set(callees.map((c) => (typeof c === 'string' ? c : (c.callee || c.name || c.symbol))))].slice(0, 6);

  if (counts) counts.textContent = `${uniqueCallers.length} callers / ${uniqueCallees.length} callees`;

  const w = 440;
  const h = 185;
  const cx = w / 2;
  const cy = h / 2;
  const lines = [];
  const nodes = [];

  const drawSide = (items, x, isLeft) => {
    const count = items.length;
    items.forEach((label, idx) => {
      const y = count === 1 ? cy : 26 + (idx * (h - 52)) / (count - 1);
      const x1 = isLeft ? x + 52 : cx + 56;
      const x2 = isLeft ? cx - 56 : x - 52;
      lines.push(`<path d="M ${x1} ${isLeft ? y : cy} C ${(x1 + x2) / 2} ${isLeft ? y : cy}, ${(x1 + x2) / 2} ${isLeft ? cy : y}, ${x2} ${isLeft ? cy : y}" fill="none" stroke="#3c6e4f" stroke-width="1.4" opacity="0.85"/>`);
      const short = label.length > 14 ? `${label.slice(0, 13)}..` : label;
      nodes.push(`
        <g class="wb-svg-node" data-sym="${escapeHtml(label)}" style="cursor:pointer">
          <rect x="${x - 52}" y="${y - 11}" width="104" height="22" rx="3" fill="#141a16" stroke="#2d4033" stroke-width="1"/>
          <text x="${x}" y="${y + 3.5}" text-anchor="middle" fill="#c7d5cb" font-family="Geist Mono, monospace" font-size="9.5">${escapeHtml(short)}</text>
        </g>
      `);
    });
  };

  drawSide(uniqueCallers, 62, true);
  drawSide(uniqueCallees, w - 62, false);

  const centerShort = centerName.length > 15 ? `${centerName.slice(0, 14)}..` : centerName;
  wrap.innerHTML = `
    <svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Call graph for ${escapeHtml(centerName)}">
      ${lines.join('')}
      ${nodes.join('')}
      <rect x="${cx - 56}" y="${cy - 14}" width="112" height="28" rx="4" fill="#1f6b3a" stroke="#5cc481" stroke-width="1.2"/>
      <text x="${cx}" y="${cy + 4}" text-anchor="middle" fill="#ffffff" font-family="Geist Mono, monospace" font-size="10.5" font-weight="600">${escapeHtml(centerShort)}</text>
    </svg>
  `;

  wrap.querySelectorAll('.wb-svg-node').forEach((g) => {
    g.addEventListener('click', () => {
      const sym = g.dataset.sym;
      if (sym) {
        document.getElementById('cd-query').value = sym;
        runCadastreSearch();
      }
    });
  });

  if (lists) {
    const colHtml = (title, items) => `
      <div class="wb-graph-col">
        <h4>${title}</h4>
        ${items.length ? items.map((s) => `<button class="wb-graph-link" type="button" data-jump-sym="${escapeHtml(s)}">${escapeHtml(s)}</button>`).join('') : '<span class="wb-pane__meta">None found</span>'}
      </div>
    `;
    lists.innerHTML = colHtml('Callers (Incoming)', uniqueCallers) + colHtml('Callees (Outgoing)', uniqueCallees);
    lists.querySelectorAll('[data-jump-sym]').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.getElementById('cd-query').value = btn.dataset.jumpSym;
        runCadastreSearch();
      });
    });
  }
}

async function selectCadastreHit(idx) {
  cadastreState.selectedIndex = idx;
  const hit = cadastreState.hits[idx];
  document.querySelectorAll('#cd-results .wb-hit').forEach((el, i) => {
    el.classList.toggle('is-active', i === idx);
  });
  if (!hit) return;

  const sym = hit.symbol || hit;
  const name = sym.name || hit.name || 'unknown';
  const file = sym.file || hit.file || '';
  const startLine = sym.startLine ?? sym.line ?? 1;
  const endLine = sym.endLine ?? startLine;

  document.getElementById('cd-sym-path').textContent = `${file}:${startLine}`;
  document.getElementById('cd-sym-meta').textContent = `${sym.kind || 'symbol'} · score ${Number(hit.score ?? 0).toFixed(3)}`;

  const headerEl = document.getElementById('cd-sym-header');
  if (headerEl) {
    const breakdown = hit.breakdown || hit.scores || {};
    headerEl.innerHTML = `
      <span class="wb-kind-tag">${escapeHtml(sym.kind || 'fn')}</span>
      <strong>${escapeHtml(name)}</strong>
      <span class="wb-pane__meta">L${startLine}-L${endLine}</span>
      ${breakdown.vector !== undefined ? `<span class="wb-pane__meta">vec:${Number(breakdown.vector).toFixed(2)}</span>` : ''}
      ${breakdown.bm25 !== undefined ? `<span class="wb-pane__meta">bm25:${Number(breakdown.bm25).toFixed(2)}</span>` : ''}
      ${breakdown.graph !== undefined ? `<span class="wb-pane__meta">graph:${Number(breakdown.graph).toFixed(2)}</span>` : ''}
    `;
  }

  const codeEl = document.getElementById('cd-sym-code');
  const snippet = sym.snippet || sym.source || sym.signature || `// ${file}:${startLine} ${name}`;
  if (codeEl) codeEl.innerHTML = `<code>${escapeHtml(snippet)}</code>`;

  // Trace callers & callees
  let callers = [];
  let callees = [];
  if (isLocalServer) {
    try {
      const [rIn, rOut] = await Promise.all([
        fetch(`./api/cadastre/callers?sym=${encodeURIComponent(name)}&depth=2`, { cache: 'no-store' }),
        fetch(`./api/cadastre/callers?sym=${encodeURIComponent(sym.qualifiedName || name)}&callees=1&depth=2`, { cache: 'no-store' }),
      ]);
      if (rIn.ok) {
        const dIn = await rIn.json();
        callers = dIn.nodes || [];
      }
      if (rOut.ok) {
        const dOut = await rOut.json();
        callees = dOut.nodes || [];
      }
    } catch {
      // Fallback to local snapshot trace
    }
  }
  if (callers.length === 0 && callees.length === 0 && cadastreState.preparedIndex) {
    const callersRes = traceCallers(cadastreState.preparedIndex, name, 2);
    const calleesRes = traceCallees(cadastreState.preparedIndex, sym.qualifiedName || name, 2);
    callers = callersRes?.nodes || [];
    callees = calleesRes?.nodes || [];
  }
  renderCadastreGraphSvg(name, callers, callees);
}

async function runCadastreSearch() {
  const query = (document.getElementById('cd-query')?.value || '').trim();
  const listEl = document.getElementById('cd-results');
  const hitCountEl = document.getElementById('cd-hit-count');
  const msEl = document.getElementById('cd-stat-ms');

  await loadCadastreAssets();

  const t0 = performance.now();
  let hits = null;

  if (isLocalServer) {
    try {
      const res = await fetch(`./api/cadastre/search?q=${encodeURIComponent(query)}&mode=${encodeURIComponent(cadastreState.mode)}&limit=25`, { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        hits = Array.isArray(data) ? data : (data.results || data.hits || []);
      }
    } catch {
      // Fallback to snapshot
    }
  }

  if (hits === null && cadastreState.preparedIndex) {
    const res = searchIndex(cadastreState.preparedIndex, query, { mode: cadastreState.mode, limit: 25 });
    hits = res.results || [];
  }

  const elapsed = performance.now() - t0;
  hits ??= [];
  cadastreState.hits = hits;
  if (msEl) msEl.textContent = `${elapsed.toFixed(2)} ms`;
  if (hitCountEl) hitCountEl.textContent = `${hits.length} hits`;

  if (!hits.length) {
    listEl.innerHTML = '<div style="padding:14px;color:var(--muted);font-family:var(--font-mono);font-size:12px;">No matching symbols found.</div>';
    return;
  }

  listEl.innerHTML = hits.map((h, i) => {
    const sym = h.symbol || h;
    const name = sym.name || 'symbol';
    const file = sym.file || '';
    const line = sym.startLine ?? sym.line ?? 1;
    const kind = sym.kind || 'fn';
    const score = Number(h.score ?? 0).toFixed(3);
    return `
      <button class="wb-hit ${i === 0 ? 'is-active' : ''}" type="button" role="option" data-hit-idx="${i}">
        <div class="wb-hit__top">
          <span class="wb-hit__name">${escapeHtml(name)}</span>
          <span class="wb-hit__score">${score}</span>
        </div>
        <div class="wb-hit__sub">
          <span>${escapeHtml(file)}:${line}</span>
          <span class="wb-kind-tag">${escapeHtml(kind)}</span>
        </div>
      </button>
    `;
  }).join('');

  listEl.querySelectorAll('.wb-hit').forEach((btn) => {
    btn.addEventListener('click', () => selectCadastreHit(Number(btn.dataset.hitIdx)));
  });

  selectCadastreHit(0);
}

function initCadastre() {
  cadastreState.initialized = true;

  document.querySelectorAll('[data-cd-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      cadastreState.mode = btn.dataset.cdMode;
      document.querySelectorAll('[data-cd-mode]').forEach((b) => {
        b.classList.toggle('is-active', b.dataset.cdMode === cadastreState.mode);
      });
      runCadastreSearch();
    });
  });

  const input = document.getElementById('cd-query');
  let debounce = null;
  input?.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(runCadastreSearch, 140);
  });
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runCadastreSearch();
  });
  document.getElementById('cd-search-btn')?.addEventListener('click', runCadastreSearch);

  document.querySelectorAll('[data-cd-q]').forEach((chip) => {
    chip.addEventListener('click', () => {
      if (input) input.value = chip.dataset.cdQ;
      runCadastreSearch();
    });
  });

  document.getElementById('cd-copy-mcp')?.addEventListener('click', (e) => {
    const text = document.getElementById('cd-mcp-json')?.textContent || '';
    copyText(text, e.currentTarget);
  });

  runCadastreSearch();
}

// ==================== TOOL 4: SLEWBOX ====================
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const QWERTY_MAP = {
  a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11,
  k: 12, o: 13, l: 14, p: 15, ';': 16,
};

const slewboxState = {
  initialized: false,
  engine: null,
  audioStarted: false,
  scopeMode: 'wave',
  baseOctave: 3,
  activeNotes: new Set(),
  rafId: null,
  patch: { ...CURATED_PATCHES[0] },
};

function midiToName(midi) {
  const name = NOTE_NAMES[midi % 12];
  const oct = Math.floor(midi / 12) - 1;
  return `${name}${oct}`;
}

function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

async function ensureSlewboxAudio() {
  if (slewboxState.audioStarted && slewboxState.engine) return true;

  if (!slewboxState.engine) {
    slewboxState.engine = new SlewboxEngine({ patch: slewboxState.patch });
  }
  const initRes = await slewboxState.engine.init();
  slewboxState.audioStarted = true;
  slewboxState.engine.setPatch(slewboxState.patch);

  const btn = document.getElementById('sb-audio-power');
  if (btn) {
    const srKhz = ((initRes.sampleRate || 48000) / 1000).toFixed(0);
    btn.textContent = `Audio Active · ${srKhz} kHz (${initRes.mode})`;
    btn.classList.remove('wb-btn--primary');
  }

  const midiStatus = document.getElementById('sb-midi-status');
  try {
    await slewboxState.engine.initMidi((st) => {
      if (midiStatus) {
        midiStatus.textContent = st.supported
          ? (st.connected > 0 ? `${st.connected} device(s)` : 'Ready')
          : 'Unavailable';
      }
    });
  } catch {
    if (midiStatus) midiStatus.textContent = 'Unavailable';
  }
  return true;
}

function syncPatchToUI() {
  const p = slewboxState.patch;
  document.getElementById('sb-voice-mode-label').textContent = p.engine;
  document.querySelectorAll('[data-sb-engine]').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.sbEngine === p.engine);
  });

  const bindings = [
    ['sb-p-detune', 'sb-v-detune', p.detuneCents ?? 11, `${Number(p.detuneCents ?? 11).toFixed(1)} ct`],
    ['sb-p-grainSize', 'sb-v-grainSize', p.grainSizeMs ?? 60, `${Math.round(p.grainSizeMs ?? 60)} ms`],
    ['sb-p-grainDensity', 'sb-v-grainDensity', p.grainDensity ?? 20, `${Math.round(p.grainDensity ?? 20)} Hz`],
    ['sb-p-fmRatio', 'sb-v-fmRatio', p.fmRatio ?? 2.0, Number(p.fmRatio ?? 2.0).toFixed(1)],
    ['sb-p-fmIndex', 'sb-v-fmIndex', p.fmIndex ?? 2.0, Number(p.fmIndex ?? 2.0).toFixed(1)],
    ['sb-p-cutoff', 'sb-v-cutoff', p.cutoff ?? 2400, `${Math.round(p.cutoff ?? 2400)} Hz`],
    ['sb-p-resonance', 'sb-v-resonance', p.resonance ?? 0.38, Number(p.resonance ?? 0.38).toFixed(2)],
    ['sb-p-gain', 'sb-v-gain', p.gain ?? 0.72, Number(p.gain ?? 0.72).toFixed(2)],
    ['sb-p-attack', 'sb-v-attack', p.attack ?? 0.012, `${Math.round((p.attack ?? 0.012) * 1000)} ms`],
    ['sb-p-decay', 'sb-v-decay', p.decay ?? 0.22, `${Math.round((p.decay ?? 0.22) * 1000)} ms`],
    ['sb-p-sustain', 'sb-v-sustain', p.sustain ?? 0.68, Number(p.sustain ?? 0.68).toFixed(2)],
    ['sb-p-release', 'sb-v-release', p.release ?? 0.28, `${Math.round((p.release ?? 0.28) * 1000)} ms`],
  ];

  for (const [inId, outId, val, label] of bindings) {
    const input = document.getElementById(inId);
    const out = document.getElementById(outId);
    if (input) input.value = String(val);
    if (out) out.textContent = label;
  }
}

async function triggerNoteOn(midi, velocity = 0.85) {
  await ensureSlewboxAudio();
  if (slewboxState.activeNotes.has(midi)) return;
  slewboxState.activeNotes.add(midi);
  slewboxState.engine?.noteOn(midi, velocity);

  const keyEl = document.querySelector(`[data-midi="${midi}"]`);
  keyEl?.classList.add('is-down');
  const noteEl = document.getElementById('sb-active-note');
  if (noteEl) noteEl.textContent = `${midiToName(midi)} (${midiToFreq(midi).toFixed(1)} Hz)`;
}

function triggerNoteOff(midi) {
  if (!slewboxState.activeNotes.has(midi)) return;
  slewboxState.activeNotes.delete(midi);
  slewboxState.engine?.noteOff(midi);

  const keyEl = document.querySelector(`[data-midi="${midi}"]`);
  keyEl?.classList.remove('is-down');
}

function renderPianoKeys() {
  const container = document.getElementById('sb-piano');
  const octLabel = document.getElementById('sb-octave-label');
  if (!container) return;

  const baseMidi = (slewboxState.baseOctave + 1) * 12; // C3 = 48
  if (octLabel) octLabel.textContent = `C${slewboxState.baseOctave} - B${slewboxState.baseOctave + 1}`;

  const kbdReverse = {};
  for (const [k, offset] of Object.entries(QWERTY_MAP)) {
    kbdReverse[offset] = k.toUpperCase();
  }

  const whites = [];
  const blacks = [];
  let whiteIndex = 0;

  for (let offset = 0; offset < 24; offset++) {
    const midi = baseMidi + offset;
    const noteInOct = offset % 12;
    const isBlack = [1, 3, 6, 8, 10].includes(noteInOct);
    const kbd = kbdReverse[offset] || '';
    if (!isBlack) {
      whites.push({ midi, label: midiToName(midi), kbd });
      whiteIndex++;
    } else {
      blacks.push({ midi, label: midiToName(midi), kbd, afterWhite: whiteIndex });
    }
  }

  container.innerHTML = whites.map((k) => `
    <button class="wb-key-white" type="button" data-midi="${k.midi}">
      <span class="wb-key-kbd">${k.kbd}</span>
      <span>${k.label}</span>
    </button>
  `).join('') + blacks.map((k) => {
    const leftPct = (k.afterWhite / whites.length) * 100;
    const widthPct = (1 / whites.length) * 62;
    return `
      <button class="wb-key-black" type="button" data-midi="${k.midi}" style="left:calc(${leftPct.toFixed(3)}% - ${(widthPct / 2).toFixed(3)}%);width:${widthPct.toFixed(3)}%">
        <span class="wb-key-kbd">${k.kbd}</span>
      </button>
    `;
  }).join('');

  container.querySelectorAll('[data-midi]').forEach((btn) => {
    const midi = Number(btn.dataset.midi);
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      btn.setPointerCapture?.(e.pointerId);
      triggerNoteOn(midi, 0.85);
    });
    const release = () => triggerNoteOff(midi);
    btn.addEventListener('pointerup', release);
    btn.addEventListener('pointercancel', release);
    btn.addEventListener('pointerleave', (e) => {
      if (e.buttons === 0) release();
    });
  });
}

function drawSlewboxScope() {
  const canvas = document.getElementById('sb-scope-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const drawFrame = () => {
    if (activeTool === 'slewbox') {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(300, Math.floor((rect.width || 900) * dpr));
      const h = Math.max(120, Math.floor((rect.height || 180) * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }

      ctx.fillStyle = '#0d120f';
      ctx.fillRect(0, 0, w, h);

      // Subtle studio graticule
      ctx.strokeStyle = 'rgba(92, 196, 129, 0.12)';
      ctx.lineWidth = 1;
      for (let i = 1; i < 4; i++) {
        const y = (h / 4) * i;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      }
      for (let i = 1; i < 8; i++) {
        const x = (w / 8) * i;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
      }

      const mode = slewboxState.scopeMode;
      const eng = slewboxState.engine;

      const drawWave = (x0, width) => {
        const buf = eng?.getTimeDomainData?.() || new Float32Array(256);
        ctx.strokeStyle = '#5cc481';
        ctx.lineWidth = 2 * dpr * 0.75;
        ctx.beginPath();
        for (let i = 0; i < buf.length; i++) {
          const x = x0 + (i / (buf.length - 1)) * width;
          const y = h * 0.5 - buf[i] * (h * 0.42);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      };

      const drawFft = (x0, width) => {
        const bins = eng?.getFrequencyData?.() || new Uint8Array(128);
        const count = Math.min(bins.length, 96);
        const barW = Math.max(2, width / count - 1);
        ctx.fillStyle = '#3b9f63';
        for (let i = 0; i < count; i++) {
          const mag = bins[i] / 255;
          const bh = mag * (h * 0.85);
          ctx.fillRect(x0 + (i / count) * width, h - bh, barW, bh);
        }
      };

      if (mode === 'wave') drawWave(0, w);
      else if (mode === 'fft') drawFft(0, w);
      else {
        drawWave(0, w * 0.5 - 6);
        ctx.strokeStyle = '#233028';
        ctx.beginPath(); ctx.moveTo(w * 0.5, 0); ctx.lineTo(w * 0.5, h); ctx.stroke();
        drawFft(w * 0.5 + 6, w * 0.5 - 6);
      }
    }
    slewboxState.rafId = requestAnimationFrame(drawFrame);
  };
  slewboxState.rafId = requestAnimationFrame(drawFrame);
}

async function initSlewbox() {
  slewboxState.initialized = true;
  renderPianoKeys();
  syncPatchToUI();
  drawSlewboxScope();

  const presetSelect = document.getElementById('sb-patch-preset');
  if (presetSelect) {
    presetSelect.innerHTML = CURATED_PATCHES
      .map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`)
      .join('');
  }

  document.getElementById('sb-audio-power')?.addEventListener('click', () => {
    ensureSlewboxAudio();
  });

  document.querySelectorAll('[data-sb-engine]').forEach((btn) => {
    btn.addEventListener('click', () => {
      slewboxState.patch.engine = btn.dataset.sbEngine;
      syncPatchToUI();
      slewboxState.engine?.setParam('engine', slewboxState.patch.engine);
    });
  });

  presetSelect?.addEventListener('change', () => {
    const found = CURATED_PATCHES.find((p) => p.id === presetSelect.value);
    if (found) {
      slewboxState.patch = { ...found };
      syncPatchToUI();
      slewboxState.engine?.setPatch(slewboxState.patch);
    }
  });

  document.querySelectorAll('[data-sb-scope]').forEach((btn) => {
    btn.addEventListener('click', () => {
      slewboxState.scopeMode = btn.dataset.sbScope;
      document.querySelectorAll('[data-sb-scope]').forEach((b) => {
        b.classList.toggle('is-active', b.dataset.sbScope === slewboxState.scopeMode);
      });
    });
  });

  const sliderMap = [
    ['sb-p-detune', 'detuneCents'],
    ['sb-p-grainSize', 'grainSizeMs'],
    ['sb-p-grainDensity', 'grainDensity'],
    ['sb-p-fmRatio', 'fmRatio'],
    ['sb-p-fmIndex', 'fmIndex'],
    ['sb-p-cutoff', 'cutoff'],
    ['sb-p-resonance', 'resonance'],
    ['sb-p-gain', 'gain'],
    ['sb-p-attack', 'attack'],
    ['sb-p-decay', 'decay'],
    ['sb-p-sustain', 'sustain'],
    ['sb-p-release', 'release'],
  ];
  for (const [elId, paramKey] of sliderMap) {
    document.getElementById(elId)?.addEventListener('input', (e) => {
      const val = Number(e.target.value);
      slewboxState.patch[paramKey] = val;
      syncPatchToUI();
      slewboxState.engine?.setParam(paramKey, val);
    });
  }

  document.getElementById('sb-oct-down')?.addEventListener('click', () => {
    slewboxState.baseOctave = Math.max(1, slewboxState.baseOctave - 1);
    renderPianoKeys();
  });
  document.getElementById('sb-oct-up')?.addEventListener('click', () => {
    slewboxState.baseOctave = Math.min(5, slewboxState.baseOctave + 1);
    renderPianoKeys();
  });

  document.getElementById('sb-test-chord')?.addEventListener('click', async () => {
    const base = (slewboxState.baseOctave + 1) * 12;
    const chord = [base, base + 4, base + 7, base + 11];
    for (const m of chord) await triggerNoteOn(m, 0.72);
    setTimeout(() => chord.forEach((m) => triggerNoteOff(m)), 750);
  });

  document.getElementById('sb-export-wav')?.addEventListener('click', () => {
    const res = renderPatchToWav(slewboxState.patch, 60, 1.5);
    const blob = res.blob || new Blob([res.bytes], { type: 'audio/wav' });
    const slug = (slewboxState.patch.name || 'slewbox').toLowerCase().replace(/[^a-z0-9]+/g, '-');
    downloadBlob(blob, `${slug}.wav`);
  });

  document.getElementById('sb-export-json')?.addEventListener('click', () => {
    const blob = new Blob([`${JSON.stringify(slewboxState.patch, null, 2)}\n`], { type: 'application/json' });
    downloadBlob(blob, 'slewbox-patch.json');
  });

  document.getElementById('sb-import-json')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      slewboxState.patch = { ...slewboxState.patch, ...parsed };
      syncPatchToUI();
      slewboxState.engine?.setPatch(slewboxState.patch);
    } catch {
      // Ignore invalid JSON
    }
    e.target.value = '';
  });

  // QWERTY keyboard playing when Slewbox tab is active
  window.addEventListener('keydown', (e) => {
    if (activeTool !== 'slewbox' || e.repeat || e.metaKey || e.ctrlKey || e.altKey || isTypingElement(e.target)) return;
    const key = e.key.toLowerCase();
    if (key in QWERTY_MAP) {
      e.preventDefault();
      const midi = (slewboxState.baseOctave + 1) * 12 + QWERTY_MAP[key];
      triggerNoteOn(midi, 0.82);
    }
  });
  window.addEventListener('keyup', (e) => {
    if (activeTool !== 'slewbox') return;
    const key = e.key.toLowerCase();
    if (key in QWERTY_MAP) {
      const midi = (slewboxState.baseOctave + 1) * 12 + QWERTY_MAP[key];
      triggerNoteOff(midi);
    }
  });
}

// ==================== TOOL 5: TAPELINE ====================
const tapelineState = {
  initialized: false,
  view: 'waterfall',
  selectedKey: 'v1',
  selectedEntryIdx: 0,
  detailTab: 'resBody',
  cassettes: {
    v1: null,
    v2: null,
    custom: null,
  },
};

function buildFallbackCassette(versionTag) {
  const isV2 = versionTag === 'v2';
  return parseCassette({
    version: '1.0',
    recordedAt: '2026-11-25T16:00:00.000Z',
    target: 'http://127.0.0.1:4100',
    entries: [
      {
        id: '001',
        method: 'GET',
        path: '/v1/health',
        status: 200,
        ttfbMs: isV2 ? 1.1 : 0.9,
        totalMs: isV2 ? 1.6 : 1.3,
        reqHeaders: { accept: 'application/json' },
        resHeaders: { 'content-type': 'application/json' },
        resBody: { status: 'ok', version: isV2 ? '1.1.0' : '1.0.0', uptimeSec: 412 },
      },
      {
        id: '002',
        method: 'POST',
        path: '/v1/orders',
        status: 201,
        ttfbMs: isV2 ? 5.8 : 3.2,
        totalMs: isV2 ? 7.9 : 4.4,
        reqHeaders: { 'content-type': 'application/json' },
        reqBody: { sku: 'dp-pro', qty: 2 },
        resHeaders: { 'content-type': 'application/json' },
        resBody: isV2
          ? { orderId: 'ord_9481', cents: '4800', currency: 'USD', region: 'us-west' }
          : { orderId: 'ord_9481', cents: 4800, currency: 'USD' },
      },
    ],
  });
}

async function loadTapelineCassettes() {
  for (const tag of ['v1', 'v2']) {
    if (tapelineState.cassettes[tag]) continue;
    try {
      const res = await fetch(`./data/tapeline-cassette-${tag}.json`, { cache: 'no-store' });
      if (res.ok) {
        tapelineState.cassettes[tag] = parseCassette(await res.json());
        continue;
      }
    } catch {
      // Fallback below
    }
    tapelineState.cassettes[tag] = buildFallbackCassette(tag);
  }
}

function getActiveCassette() {
  return tapelineState.cassettes[tapelineState.selectedKey] || tapelineState.cassettes.v1;
}

function renderTapelineDetail() {
  const cas = getActiveCassette();
  if (!cas) return;
  const entry = cas.entries[tapelineState.selectedEntryIdx];
  const routeEl = document.getElementById('tl-detail-route');
  const metaEl = document.getElementById('tl-detail-meta');
  const bodyEl = document.getElementById('tl-detail-body');
  if (!entry) return;

  if (routeEl) routeEl.textContent = `${entry.method} ${entry.path}`;
  if (metaEl) {
    metaEl.innerHTML = `
      <span>Status: <b>${entry.status}</b></span>
      <span>TTFB: <b>${entry.ttfbMs.toFixed(2)} ms</b></span>
      <span>Total: <b>${entry.totalMs.toFixed(2)} ms</b></span>
      <span>ID: <b>${escapeHtml(entry.id)}</b></span>
    `;
  }

  let content = '';
  if (tapelineState.detailTab === 'resBody') {
    content = entry.resBody !== null ? JSON.stringify(entry.resBody, null, 2) : '(empty response body)';
  } else if (tapelineState.detailTab === 'reqBody') {
    content = entry.reqBody !== null ? JSON.stringify(entry.reqBody, null, 2) : '(no request body)';
  } else {
    content = JSON.stringify({ requestHeaders: entry.reqHeaders, responseHeaders: entry.resHeaders }, null, 2);
  }
  if (bodyEl) bodyEl.innerHTML = `<code>${escapeHtml(content)}</code>`;
}

function renderTapelineWaterfall() {
  const cas = getActiveCassette();
  if (!cas) return;
  const wf = computeWaterfall(cas);

  document.getElementById('tl-wf-title').textContent = `HTTP Waterfall (${tapelineState.selectedKey})`;
  document.getElementById('tl-wf-target').textContent = wf.target;
  document.getElementById('tl-stat-count').textContent = String(wf.count);
  const avgTtfb = wf.rows.length ? wf.rows.reduce((a, r) => a + r.ttfbMs, 0) / wf.rows.length : 0;
  document.getElementById('tl-stat-ttfb').textContent = `${avgTtfb.toFixed(2)} ms`;
  document.getElementById('tl-stat-total').textContent = `${wf.cumulativeMs.toFixed(2)} ms`;

  const diff = (tapelineState.cassettes.v1 && tapelineState.cassettes.v2)
    ? diffCassettes(tapelineState.cassettes.v1, tapelineState.cassettes.v2)
    : null;
  document.getElementById('tl-stat-drifts').textContent = String(diff ? diff.summary.schemaDrifts : 0);

  const listEl = document.getElementById('tl-wf-list');
  listEl.innerHTML = wf.rows.map((r, i) => `
    <button class="wb-wf-row ${i === tapelineState.selectedEntryIdx ? 'is-active' : ''}" type="button" role="option" data-wf-idx="${i}">
      <span class="wb-route-cell">
        <span class="wb-method wb-method--${escapeHtml(r.method)}">${escapeHtml(r.method)}</span>
        <span class="wb-route-path" title="${escapeHtml(r.path)}">${escapeHtml(r.path)}</span>
      </span>
      <span><span class="wb-status-code wb-status-code--${escapeHtml(r.statusGroup)}">${r.status}</span></span>
      <span>${r.ttfbMs.toFixed(2)} ms</span>
      <span>${r.totalMs.toFixed(2)} ms</span>
      <span class="wb-wf-bar-wrap" title="TTFB ${r.ttfbMs}ms / Total ${r.totalMs}ms">
        <span class="wb-wf-bar-ttfb" style="left:0%;width:${Math.max(4, r.ttfbPct).toFixed(1)}%"></span>
        <span class="wb-wf-bar-body" style="left:${Math.max(4, r.ttfbPct).toFixed(1)}%;width:${Math.max(0, r.downloadPct).toFixed(1)}%"></span>
      </span>
    </button>
  `).join('');

  listEl.querySelectorAll('.wb-wf-row').forEach((btn) => {
    btn.addEventListener('click', () => {
      tapelineState.selectedEntryIdx = Number(btn.dataset.wfIdx);
      listEl.querySelectorAll('.wb-wf-row').forEach((el, idx) => {
        el.classList.toggle('is-active', idx === tapelineState.selectedEntryIdx);
      });
      renderTapelineDetail();
    });
  });

  renderTapelineDetail();
}

function renderTapelineDiff() {
  const before = tapelineState.cassettes.v1;
  const after = tapelineState.cassettes.custom || tapelineState.cassettes.v2;
  if (!before || !after) return;

  const diff = diffCassettes(before, after);
  const s = diff.summary;
  const summaryEl = document.getElementById('tl-diff-summary');
  const listEl = document.getElementById('tl-diff-list');
  document.getElementById('tl-stat-drifts').textContent = String(s.schemaDrifts);

  summaryEl.innerHTML = `
    <div class="wb-kpi"><span>Matched Routes</span><b>${s.matched}</b></div>
    <div class="wb-kpi"><span>Added / Removed</span><b>+${s.added} / -${s.removed}</b></div>
    <div class="wb-kpi"><span>Status Changes</span><b>${s.statusChanges}</b></div>
    <div class="wb-kpi"><span>Schema Drifts</span><b>${s.schemaDrifts}</b></div>
    <div class="wb-kpi"><span>Avg Latency Delta</span><b>${s.avgLatencyDeltaPct >= 0 ? '+' : ''}${s.avgLatencyDeltaPct.toFixed(1)}%</b></div>
  `;

  const cards = [];

  for (const r of diff.addedRoutes) {
    cards.push(`
      <div class="wb-diff-card">
        <div class="wb-diff-card__head">
          <span><span class="wb-method wb-method--${escapeHtml(r.method)}">${escapeHtml(r.method)}</span> ${escapeHtml(r.path)}</span>
          <span class="wb-badge wb-badge--ok">ADDED ROUTE (${r.status})</span>
        </div>
      </div>
    `);
  }

  for (const r of diff.removedRoutes) {
    cards.push(`
      <div class="wb-diff-card">
        <div class="wb-diff-card__head">
          <span><span class="wb-method wb-method--${escapeHtml(r.method)}">${escapeHtml(r.method)}</span> ${escapeHtml(r.path)}</span>
          <span class="wb-badge wb-badge--err">REMOVED ROUTE (BREAKING)</span>
        </div>
      </div>
    `);
  }

  for (const lat of diff.latencyDeltas) {
    const schemaHit = diff.schemaChanges.find((sc) => sc.key === lat.key);
    const statusHit = diff.statusChanges.find((sc) => sc.key === lat.key);
    const sign = lat.totalDeltaPct >= 0 ? '+' : '';
    const latBadgeClass = lat.regressed ? 'wb-badge--warn' : 'wb-badge--ok';
    const driftHtml = schemaHit
      ? schemaHit.drifts.map((d) => {
        if (d.kind === 'type_changed') {
          return `<div class="wb-drift-item wb-drift-item--changed">TYPE DRIFT ${escapeHtml(d.path)}: ${escapeHtml(d.beforeType)} -> ${escapeHtml(d.afterType)} [breaking]</div>`;
        }
        if (d.kind === 'removed') {
          return `<div class="wb-drift-item wb-drift-item--removed">REMOVED KEY ${escapeHtml(d.path)} (${escapeHtml(d.beforeType)}) [breaking]</div>`;
        }
        return `<div class="wb-drift-item wb-drift-item--added">ADDED KEY ${escapeHtml(d.path)} (${escapeHtml(d.afterType)})</div>`;
      }).join('')
      : '<div class="wb-pane__meta">0 JSON schema drifts</div>';

    cards.push(`
      <div class="wb-diff-card">
        <div class="wb-diff-card__head">
          <span><span class="wb-method wb-method--${escapeHtml(lat.method)}">${escapeHtml(lat.method)}</span> ${escapeHtml(lat.path)}</span>
          <span style="display:flex;gap:6px;align-items:center">
            ${statusHit ? `<span class="wb-badge wb-badge--err">${statusHit.beforeStatus} -> ${statusHit.afterStatus}</span>` : ''}
            <span class="wb-badge ${latBadgeClass}">${lat.beforeTotalMs.toFixed(2)}ms -> ${lat.afterTotalMs.toFixed(2)}ms (${sign}${lat.totalDeltaPct.toFixed(1)}%)</span>
          </span>
        </div>
        <div class="wb-diff-card__body">${driftHtml}</div>
      </div>
    `);
  }

  listEl.innerHTML = cards.join('') || '<div class="wb-pane__meta">No differences between v1 and v2.</div>';
}

function setTapelineView(view) {
  tapelineState.view = view;
  document.querySelectorAll('[data-tl-view]').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.tlView === view);
  });
  document.getElementById('tl-waterfall-grid').hidden = view !== 'waterfall';
  document.getElementById('tl-diff-stage').hidden = view !== 'diff';
  document.getElementById('tl-cassette-wrap').hidden = view !== 'waterfall';
  if (view === 'waterfall') renderTapelineWaterfall();
  else renderTapelineDiff();
}

async function handleTapelineFile(file) {
  try {
    const parsed = parseCassette(await file.text());
    tapelineState.cassettes.custom = parsed;
    const sel = document.getElementById('tl-cassette-select');
    if (sel && !sel.querySelector('option[value="custom"]')) {
      const opt = document.createElement('option');
      opt.value = 'custom';
      opt.textContent = file.name;
      sel.appendChild(opt);
    }
    if (sel) sel.value = 'custom';
    tapelineState.selectedKey = 'custom';
    tapelineState.selectedEntryIdx = 0;
    if (tapelineState.view === 'waterfall') renderTapelineWaterfall();
    else renderTapelineDiff();
  } catch (err) {
    alert(`Invalid Tapeline cassette JSON: ${err.message}`);
  }
}

async function initTapeline() {
  tapelineState.initialized = true;
  await loadTapelineCassettes();

  document.querySelectorAll('[data-tl-view]').forEach((btn) => {
    btn.addEventListener('click', () => setTapelineView(btn.dataset.tlView));
  });

  document.getElementById('tl-cassette-select')?.addEventListener('change', (e) => {
    tapelineState.selectedKey = e.target.value;
    tapelineState.selectedEntryIdx = 0;
    renderTapelineWaterfall();
  });

  document.querySelectorAll('[data-tl-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      tapelineState.detailTab = btn.dataset.tlTab;
      document.querySelectorAll('[data-tl-tab]').forEach((b) => {
        b.classList.toggle('is-active', b.dataset.tlTab === tapelineState.detailTab);
      });
      renderTapelineDetail();
    });
  });

  document.getElementById('tl-copy-curl')?.addEventListener('click', (e) => {
    const cas = getActiveCassette();
    const entry = cas?.entries?.[tapelineState.selectedEntryIdx];
    if (!entry) return;
    const url = `${cas.target.replace(/\/$/, '')}${entry.path}`;
    const bodyArg = entry.reqBody ? ` -d '${JSON.stringify(entry.reqBody)}'` : '';
    copyText(`curl -X ${entry.method} "${url}"${bodyArg}`, e.currentTarget);
  });

  document.getElementById('tl-file-input')?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) handleTapelineFile(file);
    e.target.value = '';
  });

  const dropZone = document.getElementById('tl-drop-zone');
  const viewEl = document.getElementById('view-tapeline');
  viewEl?.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone?.classList.add('is-dragover');
  });
  viewEl?.addEventListener('dragleave', () => {
    dropZone?.classList.remove('is-dragover');
  });
  viewEl?.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone?.classList.remove('is-dragover');
    const file = e.dataTransfer?.files?.[0];
    if (file) handleTapelineFile(file);
  });

  renderTapelineWaterfall();
}

// ==================== BOOT ====================
async function boot() {
  setupShellNavigation();
  initSubpass();

  const initialHash = window.location.hash.replace(/^#/, '').toLowerCase();
  if (TOOLS.includes(initialHash) && initialHash !== 'subpass') {
    activateTool(initialHash, false);
  }
}

boot();
