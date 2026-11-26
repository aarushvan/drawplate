// Drawplate Subpass: Live Multi-Pass WebGL2 Shader Engine & Pass Profiler
// Runs 3 real toggleable render passes (geometry, bloom, tonemap) over WebGL2 FBOs
// with EXT_disjoint_timer_query_webgl2 GPU pass timing and graceful Canvas2D fallback.

import {
  FULLSCREEN_VERT_GLSL,
  BLOOM_EXTRACT_GLSL,
  BLOOM_BLUR_GLSL,
  TONEMAP_ACES_GLSL,
  SHADER_PRESETS,
  getShaderPreset,
} from './shaders.mjs';

function parseGlslErrors(log) {
  if (!log || !log.trim()) return [];
  const errors = [];
  const lines = log.split('\n');
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    // Chrome/ANGLE/WebGL format: "ERROR: 0:42: 'foo' : undeclared identifier"
    const m1 = trimmed.match(/^(?:ERROR|WARNING):\s*\d+:(\d+):\s*(.+)$/i);
    if (m1) {
      errors.push({ line: Number(m1[1]), message: m1[2].trim() });
      continue;
    }
    // NVIDIA/Mesa format: "0(42) : error C0000: ..."
    const m2 = trimmed.match(/^\d+\((\d+)\)\s*:\s*(.+)$/);
    if (m2) {
      errors.push({ line: Number(m2[1]), message: m2[2].trim() });
      continue;
    }
    errors.push({ line: 1, message: trimmed });
  }
  return errors;
}

function nowMs() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

export class SubpassEngine {
  constructor(canvas, options = {}) {
    if (!canvas) {
      throw new Error('SubpassEngine requires a canvas element');
    }
    this.canvas = canvas;
    this.options = options;
    this.onStats = typeof options.onStats === 'function' ? options.onStats : null;
    this.onCompile = typeof options.onCompile === 'function' ? options.onCompile : null;

    this.uniforms = {
      bloomThreshold: options.bloomThreshold ?? 0.72,
      bloomIntensity: options.bloomIntensity ?? 0.65,
      exposure: options.exposure ?? 1.15,
      speed: options.speed ?? 1.0,
    };

    this.passEnabled = {
      geometry: true,
      bloom: true,
      tonemap: true,
      ...(options.passEnabled || {}),
    };

    this.mouse = { x: 0.5, y: 0.5 };
    this.paused = false;
    this.destroyed = false;
    this.rafId = null;
    this.elapsedSec = 0;
    this.lastFrameTimestamp = 0;

    const initialPreset = getShaderPreset(options.presetId || 'pbr_sphere');
    this.currentPresetId = initialPreset.id;
    this.currentSource = initialPreset.source;

    this.stats = {
      fps: 60,
      frameMs: 16.67,
      compileMs: 0,
      passes: { geometry: 0.42, bloom: 0.18, tonemap: 0.11 },
      backend: 'webgl2',
      timerMode: 'cpu-perf',
      fboFormat: 'RGBA8',
      resolution: { width: 0, height: 0 },
    };

    this._gl = null;
    this._ctx2d = null;
    this._timerExt = null;
    this._floatExt = null;
    this._vao = null;
    this._programs = {
      user: null,
      bloomExtract: null,
      bloomBlur: null,
      tonemap: null,
    };
    this._fbos = {
      scene: null,
      bloomA: null,
      bloomB: null,
    };
    this._pendingQueries = [];
    this._fboWidth = 0;
    this._fboHeight = 0;
    this._lastStatsEmit = 0;

    this._onPointerMove = (evt) => {
      const rect = this.canvas.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        this.mouse.x = Math.min(1, Math.max(0, (evt.clientX - rect.left) / rect.width));
        this.mouse.y = Math.min(1, Math.max(0, 1 - (evt.clientY - rect.top) / rect.height));
      }
    };
    if (typeof this.canvas.addEventListener === 'function') {
      this.canvas.addEventListener('pointermove', this._onPointerMove);
    }

    this._initBackend();

    if (options.autoStart !== false) {
      this.start();
    }
  }

  _initBackend() {
    let gl = null;
    try {
      gl = this.canvas.getContext('webgl2', {
        antialias: false,
        alpha: false,
        depth: false,
        stencil: false,
        powerPreference: 'high-performance',
        preserveDrawingBuffer: true,
      });
    } catch {
      gl = null;
    }

    if (!gl) {
      this.stats.backend = 'canvas2d';
      this.stats.timerMode = 'cpu-perf';
      this.stats.fboFormat = '2D';
      this._ctx2d = this.canvas.getContext('2d');
      this.resize();
      return;
    }

    this._gl = gl;
    this._floatExt = gl.getExtension('EXT_color_buffer_float');
    this._timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.stats.backend = 'webgl2';
    this.stats.fboFormat = this._floatExt ? 'RGBA16F' : 'RGBA8';
    this.stats.timerMode = this._timerExt ? 'gpu-query' : 'cpu-perf';

    // Empty VAO required by WebGL2 core profile for vertex-ID fullscreen triangle
    this._vao = gl.createVertexArray();

    // Compile fixed post-processing programs
    const extractRes = this._buildProgram(FULLSCREEN_VERT_GLSL, BLOOM_EXTRACT_GLSL);
    const blurRes = this._buildProgram(FULLSCREEN_VERT_GLSL, BLOOM_BLUR_GLSL);
    const tonemapRes = this._buildProgram(FULLSCREEN_VERT_GLSL, TONEMAP_ACES_GLSL);

    if (!extractRes.ok || !blurRes.ok || !tonemapRes.ok) {
      // Fallback safely to 2D if driver fails standard post shaders
      this.stats.backend = 'canvas2d';
      this._gl = null;
      this._ctx2d = this.canvas.getContext('2d');
      this.resize();
      return;
    }

    this._programs.bloomExtract = extractRes.program;
    this._programs.bloomBlur = blurRes.program;
    this._programs.tonemap = tonemapRes.program;

    this.resize();
    this.compileUserShader(this.currentSource);
  }

  _compileShader(type, source) {
    const gl = this._gl;
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    const ok = gl.getShaderParameter(shader, gl.COMPILE_STATUS);
    const log = gl.getShaderInfoLog(shader) || '';
    if (!ok) {
      gl.deleteShader(shader);
      return { ok: false, shader: null, log };
    }
    return { ok: true, shader, log };
  }

  _buildProgram(vertSrc, fragSrc) {
    const gl = this._gl;
    const vs = this._compileShader(gl.VERTEX_SHADER, vertSrc);
    if (!vs.ok) {
      return { ok: false, program: null, errors: parseGlslErrors(vs.log), rawLog: vs.log };
    }
    const fs = this._compileShader(gl.FRAGMENT_SHADER, fragSrc);
    if (!fs.ok) {
      gl.deleteShader(vs.shader);
      return { ok: false, program: null, errors: parseGlslErrors(fs.log), rawLog: fs.log };
    }

    const program = gl.createProgram();
    gl.attachShader(program, vs.shader);
    gl.attachShader(program, fs.shader);
    gl.linkProgram(program);
    gl.deleteShader(vs.shader);
    gl.deleteShader(fs.shader);

    const linked = gl.getProgramParameter(program, gl.LINK_STATUS);
    const log = gl.getProgramInfoLog(program) || '';
    if (!linked) {
      gl.deleteProgram(program);
      return { ok: false, program: null, errors: parseGlslErrors(log), rawLog: log };
    }
    return { ok: true, program, errors: [], rawLog: log };
  }

  _createFboTarget(width, height) {
    const gl = this._gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);

    const useFloat = Boolean(this._floatExt);
    const internalFormat = useFloat ? gl.RGBA16F : gl.RGBA8;
    const type = useFloat ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;

    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, width, height, 0, gl.RGBA, type, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);

    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);

    if (status !== gl.FRAMEBUFFER_COMPLETE && useFloat) {
      // Fallback to RGBA8 if RGBA16F attachment is incomplete on this GPU
      gl.deleteFramebuffer(fbo);
      gl.deleteTexture(tex);
      this._floatExt = null;
      this.stats.fboFormat = 'RGBA8';
      return this._createFboTarget(width, height);
    }

    return { fbo, tex, width, height };
  }

  _destroyFbos() {
    const gl = this._gl;
    if (!gl) return;
    for (const key of ['scene', 'bloomA', 'bloomB']) {
      const target = this._fbos[key];
      if (target) {
        gl.deleteFramebuffer(target.fbo);
        gl.deleteTexture(target.tex);
        this._fbos[key] = null;
      }
    }
  }

  resize() {
    const dpr = Math.min(
      this.options.pixelRatio ?? (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1),
      2
    );
    const rect = typeof this.canvas.getBoundingClientRect === 'function'
      ? this.canvas.getBoundingClientRect()
      : { width: this.canvas.width || 640, height: this.canvas.height || 360 };

    const targetW = Math.max(2, Math.floor((rect.width || this.canvas.width || 640) * dpr));
    const targetH = Math.max(2, Math.floor((rect.height || this.canvas.height || 360) * dpr));

    if (this.canvas.width !== targetW || this.canvas.height !== targetH) {
      this.canvas.width = targetW;
      this.canvas.height = targetH;
    }

    this.stats.resolution = { width: targetW, height: targetH };

    if (this._gl && (this._fboWidth !== targetW || this._fboHeight !== targetH)) {
      this._destroyFbos();
      const halfW = Math.max(2, Math.floor(targetW / 2));
      const halfH = Math.max(2, Math.floor(targetH / 2));
      this._fbos.scene = this._createFboTarget(targetW, targetH);
      this._fbos.bloomA = this._createFboTarget(halfW, halfH);
      this._fbos.bloomB = this._createFboTarget(halfW, halfH);
      this._fboWidth = targetW;
      this._fboHeight = targetH;
    }
  }

  compileUserShader(glslSource) {
    const start = nowMs();
    this.currentSource = glslSource;

    if (!this._gl) {
      const compileMs = Math.max(0.05, nowMs() - start);
      this.stats.compileMs = compileMs;
      const res = { ok: true, compileMs, errors: [], rawLog: '' };
      if (this.onCompile) this.onCompile(res);
      return res;
    }

    const build = this._buildProgram(FULLSCREEN_VERT_GLSL, glslSource);
    const compileMs = Number((nowMs() - start).toFixed(2));
    this.stats.compileMs = compileMs;

    if (build.ok) {
      if (this._programs.user) {
        this._gl.deleteProgram(this._programs.user);
      }
      this._programs.user = build.program;
    }

    const result = {
      ok: build.ok,
      compileMs,
      errors: build.errors,
      rawLog: build.rawLog,
    };

    if (this.onCompile) this.onCompile(result);
    if (this.paused && build.ok) {
      this.step();
    }
    return result;
  }

  setPreset(presetId) {
    const preset = getShaderPreset(presetId);
    this.currentPresetId = preset.id;
    return this.compileUserShader(preset.source);
  }

  getPresets() {
    return SHADER_PRESETS;
  }

  setUniform(name, value) {
    if (Object.prototype.hasOwnProperty.call(this.uniforms, name)) {
      this.uniforms[name] = Number(value);
      if (this.paused) this.step();
    }
  }

  setUniforms(partial) {
    for (const [k, v] of Object.entries(partial || {})) {
      if (Object.prototype.hasOwnProperty.call(this.uniforms, k)) {
        this.uniforms[k] = Number(v);
      }
    }
    if (this.paused) this.step();
  }

  setPassEnabled(passName, enabled) {
    if (Object.prototype.hasOwnProperty.call(this.passEnabled, passName)) {
      this.passEnabled[passName] = Boolean(enabled);
      if (this.paused) this.step();
    }
  }

  getPassEnabled() {
    return { ...this.passEnabled };
  }

  getStats() {
    return {
      ...this.stats,
      passes: { ...this.stats.passes },
      resolution: { ...this.stats.resolution },
    };
  }

  _beginPassTimer(passName) {
    const cpuStart = nowMs();
    let gpuQuery = null;
    if (this._gl && this._timerExt && this._pendingQueries.length < 24) {
      gpuQuery = this._gl.createQuery();
      this._gl.beginQuery(this._timerExt.TIME_ELAPSED_EXT, gpuQuery);
    }
    return { passName, cpuStart, gpuQuery };
  }

  _endPassTimer(token) {
    const cpuMs = nowMs() - token.cpuStart;
    if (token.gpuQuery && this._gl && this._timerExt) {
      this._gl.endQuery(this._timerExt.TIME_ELAPSED_EXT);
      this._pendingQueries.push({ passName: token.passName, query: token.gpuQuery });
    } else {
      const prev = this.stats.passes[token.passName] || cpuMs;
      this.stats.passes[token.passName] = prev * 0.8 + cpuMs * 0.2;
    }
  }

  _pollGpuQueries() {
    if (!this._gl || !this._timerExt || this._pendingQueries.length === 0) return;
    const gl = this._gl;
    const disjoint = gl.getParameter(this._timerExt.GPU_DISJOINT_EXT);

    const remaining = [];
    for (const item of this._pendingQueries) {
      const available = gl.getQueryParameter(item.query, gl.QUERY_RESULT_AVAILABLE);
      if (available) {
        if (!disjoint) {
          const ns = gl.getQueryParameter(item.query, gl.QUERY_RESULT);
          const ms = ns / 1e6;
          const prev = this.stats.passes[item.passName] || ms;
          this.stats.passes[item.passName] = prev * 0.8 + ms * 0.2;
        }
        gl.deleteQuery(item.query);
      } else {
        remaining.push(item);
      }
    }
    this._pendingQueries = remaining;
  }

  _renderWebGL2() {
    const gl = this._gl;
    this.resize();
    this._pollGpuQueries();

    const { scene, bloomA, bloomB } = this._fbos;
    if (!scene || !bloomA || !bloomB) return;

    gl.bindVertexArray(this._vao);

    // PASS 1: Geometry / Raymarch User Shader -> scene FBO
    const geomTimer = this._beginPassTimer('geometry');
    gl.bindFramebuffer(gl.FRAMEBUFFER, scene.fbo);
    gl.viewport(0, 0, scene.width, scene.height);

    if (this.passEnabled.geometry && this._programs.user) {
      const prog = this._programs.user;
      gl.useProgram(prog);
      const uRes = gl.getUniformLocation(prog, 'u_resolution');
      const uTime = gl.getUniformLocation(prog, 'u_time');
      const uSpeed = gl.getUniformLocation(prog, 'u_speed');
      const uMouse = gl.getUniformLocation(prog, 'u_mouse');
      if (uRes) gl.uniform2f(uRes, scene.width, scene.height);
      if (uTime) gl.uniform1f(uTime, this.elapsedSec);
      if (uSpeed) gl.uniform1f(uSpeed, this.uniforms.speed);
      if (uMouse) gl.uniform2f(uMouse, this.mouse.x, this.mouse.y);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    } else {
      gl.clearColor(0.015, 0.025, 0.02, 1.0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    this._endPassTimer(geomTimer);

    // PASS 2: Bloom (Karis luminance threshold extract + separable H/V Gaussian blur)
    const bloomTimer = this._beginPassTimer('bloom');
    if (this.passEnabled.bloom) {
      // 2a: Extract to bloomA
      gl.bindFramebuffer(gl.FRAMEBUFFER, bloomA.fbo);
      gl.viewport(0, 0, bloomA.width, bloomA.height);
      const extProg = this._programs.bloomExtract;
      gl.useProgram(extProg);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, scene.tex);
      gl.uniform1i(gl.getUniformLocation(extProg, 'u_sceneTex'), 0);
      gl.uniform2f(gl.getUniformLocation(extProg, 'u_texelSize'), 1 / scene.width, 1 / scene.height);
      gl.uniform1f(gl.getUniformLocation(extProg, 'u_bloomThreshold'), this.uniforms.bloomThreshold);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      // 2b: Horizontal Gaussian blur bloomA -> bloomB
      const blurProg = this._programs.bloomBlur;
      gl.useProgram(blurProg);
      gl.bindFramebuffer(gl.FRAMEBUFFER, bloomB.fbo);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, bloomA.tex);
      gl.uniform1i(gl.getUniformLocation(blurProg, 'u_inputTex'), 0);
      gl.uniform2f(gl.getUniformLocation(blurProg, 'u_direction'), 1.0, 0.0);
      gl.uniform2f(gl.getUniformLocation(blurProg, 'u_texelSize'), 1 / bloomA.width, 1 / bloomA.height);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      // 2c: Vertical Gaussian blur bloomB -> bloomA
      gl.bindFramebuffer(gl.FRAMEBUFFER, bloomA.fbo);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, bloomB.tex);
      gl.uniform2f(gl.getUniformLocation(blurProg, 'u_direction'), 0.0, 1.0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, bloomA.fbo);
      gl.viewport(0, 0, bloomA.width, bloomA.height);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    this._endPassTimer(bloomTimer);

    // PASS 3: ACES Filmic Tonemap + Composite -> Default Framebuffer
    const toneTimer = this._beginPassTimer('tonemap');
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    const tmProg = this._programs.tonemap;
    gl.useProgram(tmProg);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, scene.tex);
    gl.uniform1i(gl.getUniformLocation(tmProg, 'u_sceneTex'), 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, bloomA.tex);
    gl.uniform1i(gl.getUniformLocation(tmProg, 'u_bloomTex'), 1);

    gl.uniform1f(gl.getUniformLocation(tmProg, 'u_bloomIntensity'), this.uniforms.bloomIntensity);
    gl.uniform1f(gl.getUniformLocation(tmProg, 'u_exposure'), this.uniforms.exposure);
    gl.uniform1f(gl.getUniformLocation(tmProg, 'u_bloomEnabled'), this.passEnabled.bloom ? 1.0 : 0.0);
    gl.uniform1f(gl.getUniformLocation(tmProg, 'u_tonemapEnabled'), this.passEnabled.tonemap ? 1.0 : 0.0);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this._endPassTimer(toneTimer);

    gl.bindVertexArray(null);
  }

  _renderCanvas2D() {
    const ctx = this._ctx2d;
    if (!ctx) return;
    this.resize();
    const w = this.canvas.width;
    const h = this.canvas.height;
    const t = this.elapsedSec * this.uniforms.speed;

    const gStart = nowMs();
    ctx.fillStyle = '#0b100d';
    ctx.fillRect(0, 0, w, h);

    if (this.passEnabled.geometry) {
      // Precision grid
      ctx.strokeStyle = 'rgba(46, 168, 106, 0.14)';
      ctx.lineWidth = 1;
      const step = Math.max(24, Math.floor(Math.min(w, h) / 14));
      for (let x = (w % step) / 2; x < w; x += step) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
      for (let y = (h % step) / 2; y < h; y += step) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }

      // Procedural jade/amber calibration sphere
      const cx = w * 0.5;
      const cy = h * 0.5;
      const r = Math.min(w, h) * 0.26;
      const grad = ctx.createRadialGradient(
        cx - r * 0.32, cy - r * 0.32, r * 0.08,
        cx, cy, r
      );
      grad.addColorStop(0, '#5ce096');
      grad.addColorStop(0.45, '#1f6b3a');
      grad.addColorStop(1, '#09110d');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();

      // Orbiting warm-amber calibration ring
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(t * 0.45);
      ctx.strokeStyle = '#d98a36';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.ellipse(0, 0, r * 1.38, r * 0.42, 0.25, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    const gMs = nowMs() - gStart;

    const bStart = nowMs();
    if (this.passEnabled.bloom) {
      const cx = w * 0.5;
      const cy = h * 0.5;
      const r = Math.min(w, h) * 0.48;
      const glow = ctx.createRadialGradient(cx, cy, r * 0.1, cx, cy, r);
      const alpha = Math.min(0.45, this.uniforms.bloomIntensity * 0.26);
      glow.addColorStop(0, `rgba(74, 214, 134, ${alpha})`);
      glow.addColorStop(1, 'rgba(11, 16, 13, 0)');
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, w, h);
    }
    const bMs = nowMs() - bStart;

    const tStart = nowMs();
    if (this.passEnabled.tonemap) {
      const vig = ctx.createRadialGradient(w * 0.5, h * 0.5, Math.min(w, h) * 0.25, w * 0.5, h * 0.5, Math.max(w, h) * 0.72);
      vig.addColorStop(0, 'rgba(0,0,0,0)');
      vig.addColorStop(1, 'rgba(5,9,7,0.38)');
      ctx.fillStyle = vig;
      ctx.fillRect(0, 0, w, h);
    }
    const tMs = nowMs() - tStart;

    this.stats.passes.geometry = this.stats.passes.geometry * 0.8 + gMs * 0.2;
    this.stats.passes.bloom = this.stats.passes.bloom * 0.8 + bMs * 0.2;
    this.stats.passes.tonemap = this.stats.passes.tonemap * 0.8 + tMs * 0.2;
  }

  step(deltaSec = 1 / 60) {
    if (this.destroyed) return;
    this.elapsedSec += deltaSec;
    if (this._gl) {
      this._renderWebGL2();
    } else {
      this._renderCanvas2D();
    }
  }

  _tick = (timestamp) => {
    if (this.destroyed || this.paused) return;

    if (this.lastFrameTimestamp === 0) {
      this.lastFrameTimestamp = timestamp;
    }
    const dtMs = Math.max(0.5, Math.min(100, timestamp - this.lastFrameTimestamp));
    this.lastFrameTimestamp = timestamp;
    this.elapsedSec += dtMs / 1000;

    if (this._gl) {
      this._renderWebGL2();
    } else {
      this._renderCanvas2D();
    }

    this.stats.frameMs = this.stats.frameMs * 0.88 + dtMs * 0.12;
    this.stats.fps = 1000 / Math.max(this.stats.frameMs, 0.1);

    if (this.onStats && timestamp - this._lastStatsEmit >= 120) {
      this._lastStatsEmit = timestamp;
      this.onStats(this.getStats());
    }

    if (typeof requestAnimationFrame === 'function') {
      this.rafId = requestAnimationFrame(this._tick);
    }
  };

  start() {
    if (this.destroyed) return;
    this.paused = false;
    this.lastFrameTimestamp = 0;
    if (this.rafId === null && typeof requestAnimationFrame === 'function') {
      this.rafId = requestAnimationFrame(this._tick);
    } else if (typeof requestAnimationFrame !== 'function') {
      this.step();
    }
  }

  resume() {
    this.start();
  }

  pause() {
    this.paused = true;
    if (this.rafId !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  isPaused() {
    return this.paused;
  }

  destroy() {
    this.pause();
    this.destroyed = true;
    if (typeof this.canvas.removeEventListener === 'function') {
      this.canvas.removeEventListener('pointermove', this._onPointerMove);
    }
    if (this._gl) {
      const gl = this._gl;
      this._destroyFbos();
      for (const item of this._pendingQueries) {
        gl.deleteQuery(item.query);
      }
      this._pendingQueries = [];
      for (const key of Object.keys(this._programs)) {
        if (this._programs[key]) {
          gl.deleteProgram(this._programs[key]);
          this._programs[key] = null;
        }
      }
      if (this._vao) {
        gl.deleteVertexArray(this._vao);
        this._vao = null;
      }
      this._gl = null;
    }
  }
}
