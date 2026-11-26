// Drawplate Subpass: Real GLSL ES 3.00 Shaders and Multi-Pass Post-Processing Pipeline
// Palette constraint: obsidian, brushed slate, emerald/jade, warm amber (zero violet/lavender).

export const FULLSCREEN_VERT_GLSL = `#version 300 es
precision highp float;

out vec2 vUv;

void main() {
  // Fullscreen triangle from gl_VertexID (0, 1, 2) with zero vertex buffer overhead
  vec2 pos = vec2(
    float((gl_VertexID & 1) << 2) - 1.0,
    float((gl_VertexID & 2) << 1) - 1.0
  );
  vUv = pos * 0.5 + 0.5;
  gl_Position = vec4(pos, 0.0, 1.0);
}
`;

export const PBR_SPHERE_GLSL = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform vec2 u_resolution;
uniform float u_time;
uniform float u_speed;
uniform vec2 u_mouse;

const float PI = 3.14159265359;

mat2 rot2(float a) {
  float c = cos(a);
  float s = sin(a);
  return mat2(c, -s, s, c);
}

float sdSphere(vec3 p, float r) {
  return length(p) - r;
}

float sdTorus(vec3 p, vec2 t) {
  vec2 q = vec2(length(p.xz) - t.x, p.y);
  return length(q) - t.y;
}

float sdBox(vec3 p, vec3 b) {
  vec3 q = abs(p) - b;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
}

// Returns vec2(distance, materialId)
// 1.0 = machined jade alloy sphere, 2.0 = brushed amber calibration ring, 3.0 = obsidian optical table
vec2 mapScene(vec3 p, float t) {
  vec3 sp = p - vec3(0.0, 0.14 + 0.05 * sin(t * 1.1), 0.0);
  // Subtle machined grooves on sphere equator
  vec3 rp = sp;
  rp.xz *= rot2(t * 0.35);
  rp.xy *= rot2(0.28);
  float grooves = 0.008 * sin(rp.y * 42.0) * smoothstep(0.45, 0.0, abs(rp.y));
  float sphereD = sdSphere(sp, 0.86) + grooves;
  vec2 res = vec2(sphereD, 1.0);

  // Orbiting warm-amber precision gimbal ring
  vec3 gp = sp;
  gp.xz *= rot2(-t * 0.48);
  gp.yz *= rot2(0.55 + 0.15 * sin(t * 0.7));
  float ringD = sdTorus(gp, vec2(1.16, 0.028));
  if (ringD < res.x) {
    res = vec2(ringD, 2.0);
  }

  // Secondary jade alignment ring
  vec3 gp2 = sp;
  gp2.xz *= rot2(t * 0.32 + 1.1);
  gp2.xy *= rot2(-0.62);
  float ring2D = sdTorus(gp2, vec2(1.32, 0.016));
  if (ring2D < res.x) {
    res = vec2(ring2D, 4.0);
  }

  // Optical bench floor plane with recessed plinth
  float floorD = p.y + 0.96;
  float plinthD = sdBox(p - vec3(0.0, -0.92, 0.0), vec3(1.55, 0.05, 1.55)) - 0.02;
  float benchD = min(floorD, plinthD);
  if (benchD < res.x) {
    res = vec2(benchD, 3.0);
  }

  return res;
}

vec3 calcNormal(vec3 p, float t) {
  vec2 e = vec2(0.0012, 0.0);
  return normalize(vec3(
    mapScene(p + e.xyy, t).x - mapScene(p - e.xyy, t).x,
    mapScene(p + e.yxy, t).x - mapScene(p - e.yxy, t).x,
    mapScene(p + e.yyx, t).x - mapScene(p - e.yyx, t).x
  ));
}

float softShadow(vec3 ro, vec3 rd, float mint, float maxt, float k, float t) {
  float res = 1.0;
  float ph = 1e20;
  float dist = mint;
  for (int i = 0; i < 36; i++) {
    float h = mapScene(ro + rd * dist, t).x;
    if (h < 0.001) return 0.0;
    float y = h * h / (2.0 * ph);
    float d = sqrt(max(0.0, h * h - y * y));
    res = min(res, k * d / max(0.0, dist - y));
    ph = h;
    dist += clamp(h, 0.02, 0.25);
    if (dist > maxt) break;
  }
  return clamp(res, 0.0, 1.0);
}

float calcAO(vec3 pos, vec3 nor, float t) {
  float occ = 0.0;
  float sca = 1.0;
  for (int i = 0; i < 5; i++) {
    float h = 0.02 + 0.11 * float(i);
    float d = mapScene(pos + h * nor, t).x;
    occ += (h - d) * sca;
    sca *= 0.72;
  }
  return clamp(1.0 - 2.4 * occ, 0.0, 1.0);
}

// Cook-Torrance GGX PBR lighting
float distributionGGX(vec3 N, vec3 H, float roughness) {
  float a = roughness * roughness;
  float a2 = a * a;
  float NdotH = max(dot(N, H), 0.0);
  float denom = (NdotH * NdotH * (a2 - 1.0) + 1.0);
  return a2 / max(PI * denom * denom, 0.0001);
}

float geometrySmith(vec3 N, vec3 V, vec3 L, float roughness) {
  float r = roughness + 1.0;
  float k = (r * r) / 8.0;
  float NdotV = max(dot(N, V), 0.0);
  float NdotL = max(dot(N, L), 0.0);
  float ggxV = NdotV / (NdotV * (1.0 - k) + k);
  float ggxL = NdotL / (NdotL * (1.0 - k) + k);
  return ggxV * ggxL;
}

vec3 fresnelSchlick(float cosTheta, vec3 F0) {
  return F0 + (1.0 - F0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}

vec3 studioEnv(vec3 rd) {
  float up = clamp(rd.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 base = mix(vec3(0.015, 0.024, 0.020), vec3(0.06, 0.11, 0.085), up);
  // Crisp softbox strip reflection
  float strip1 = smoothstep(0.84, 0.98, dot(rd, normalize(vec3(0.55, 0.65, 0.45))));
  float strip2 = smoothstep(0.88, 0.99, dot(rd, normalize(vec3(-0.75, 0.35, -0.3))));
  base += vec3(0.95, 1.15, 1.02) * strip1 * 1.45;
  base += vec3(1.45, 0.92, 0.38) * strip2 * 1.1;
  return base;
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / max(u_resolution.y, 1.0);
  float t = u_time * max(u_speed, 0.0);

  // Subtle orbital camera with optional mouse offset
  float camYaw = 0.28 * sin(t * 0.25) + (u_mouse.x - 0.5) * 0.85;
  float camPitch = 0.16 + (u_mouse.y - 0.5) * 0.35;
  vec3 ro = vec3(0.0, 0.25, 3.35);
  ro.yz *= rot2(camPitch);
  ro.xz *= rot2(camYaw);

  vec3 ta = vec3(0.0, 0.02, 0.0);
  vec3 ww = normalize(ta - ro);
  vec3 uu = normalize(cross(ww, vec3(0.0, 1.0, 0.0)));
  vec3 vv = cross(uu, ww);
  vec3 rd = normalize(uv.x * uu + uv.y * vv + 1.65 * ww);

  vec3 col = studioEnv(rd) * 0.45;

  float dist = 0.0;
  float matId = -1.0;
  for (int i = 0; i < 84; i++) {
    vec2 h = mapScene(ro + rd * dist, t);
    if (h.x < 0.0012) {
      matId = h.y;
      break;
    }
    dist += h.x;
    if (dist > 14.0) break;
  }

  if (matId > 0.0) {
    vec3 pos = ro + rd * dist;
    vec3 N = calcNormal(pos, t);
    vec3 V = -rd;
    float ao = calcAO(pos, N, t);

    vec3 albedo = vec3(0.08, 0.22, 0.15);
    float metallic = 0.78;
    float roughness = 0.22;
    vec3 emissive = vec3(0.0);

    if (matId < 1.5) {
      // Machined emerald-slate titanium alloy sphere
      float bands = 0.5 + 0.5 * sin(pos.y * 22.0 + t * 0.8);
      albedo = mix(vec3(0.06, 0.19, 0.13), vec3(0.16, 0.44, 0.28), bands * 0.45);
      metallic = 0.86;
      roughness = mix(0.14, 0.30, bands);
    } else if (matId < 2.5) {
      // Brushed warm-amber brass ring with HDR glow edge
      albedo = vec3(0.88, 0.56, 0.20);
      metallic = 0.92;
      roughness = 0.18;
      emissive = vec3(1.25, 0.68, 0.18) * 0.42;
    } else if (matId < 3.5) {
      // Obsidian calibration optical bench with precision grid
      vec2 grid = abs(fract(pos.xz * 2.0 - 0.5) - 0.5) / max(fwidth(pos.xz * 2.0), vec2(0.001));
      float line = 1.0 - min(min(grid.x, grid.y), 1.0);
      vec2 majorGrid = abs(fract(pos.xz * 0.5 - 0.5) - 0.5) / max(fwidth(pos.xz * 0.5), vec2(0.001));
      float major = 1.0 - min(min(majorGrid.x, majorGrid.y), 1.0);
      albedo = vec3(0.028, 0.038, 0.033) + vec3(0.05, 0.16, 0.10) * line * 0.35;
      metallic = 0.22;
      roughness = mix(0.42, 0.18, line);
      emissive = vec3(0.12, 0.48, 0.28) * line * 0.16 * exp(-length(pos.xz) * 0.32);
      emissive += vec3(0.45, 0.32, 0.12) * major * 0.04;
    } else {
      // Secondary jade fiber ring
      albedo = vec3(0.18, 0.72, 0.44);
      metallic = 0.65;
      roughness = 0.20;
      emissive = vec3(0.24, 1.15, 0.62) * 0.65;
    }

    vec3 F0 = mix(vec3(0.04), albedo, metallic);

    // Key light (cool studio white-emerald) + Warm amber rim light
    vec3 lightDirs[2];
    vec3 lightCols[2];
    lightDirs[0] = normalize(vec3(2.2, 3.1, 2.4));
    lightCols[0] = vec3(2.6, 2.85, 2.65);
    lightDirs[1] = normalize(vec3(-2.6, 1.2, -1.8));
    lightCols[1] = vec3(2.2, 1.25, 0.45);

    vec3 Lo = vec3(0.0);
    for (int i = 0; i < 2; i++) {
      vec3 L = lightDirs[i];
      vec3 H = normalize(V + L);
      float NdotL = max(dot(N, L), 0.0);
      float sh = (i == 0) ? softShadow(pos + N * 0.004, L, 0.02, 6.0, 14.0, t) : 1.0;

      float NDF = distributionGGX(N, H, roughness);
      float G = geometrySmith(N, V, L, roughness);
      vec3 F = fresnelSchlick(max(dot(H, V), 0.0), F0);

      vec3 spec = (NDF * G * F) / max(4.0 * max(dot(N, V), 0.0) * NdotL, 0.001);
      vec3 kD = (vec3(1.0) - F) * (1.0 - metallic);
      Lo += (kD * albedo / PI + spec) * lightCols[i] * NdotL * sh;
    }

    // Environment reflection + crisp Fresnel rim
    vec3 R = reflect(-V, N);
    vec3 envSpec = studioEnv(R) * fresnelSchlick(max(dot(N, V), 0.0), F0) * (1.0 - roughness * 0.75);
    float rim = pow(1.0 - max(dot(N, V), 0.0), 3.6);
    vec3 rimGlow = mix(vec3(0.18, 0.88, 0.50), vec3(1.1, 0.65, 0.22), 0.35) * rim * 0.45;

    col = Lo + envSpec * ao + albedo * vec3(0.04, 0.07, 0.055) * ao + rimGlow * ao + emissive;
    // Distance depth attenuation toward obsidian horizon
    float fog = 1.0 - exp(-0.022 * dist * dist);
    col = mix(col, vec3(0.014, 0.022, 0.018), clamp(fog, 0.0, 1.0));
  }

  fragColor = vec4(col, 1.0);
}
`;

export const SDF_LATTICE_GLSL = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform vec2 u_resolution;
uniform float u_time;
uniform float u_speed;
uniform vec2 u_mouse;

mat2 rot2(float a) {
  float c = cos(a);
  float s = sin(a);
  return mat2(c, -s, s, c);
}

float sdOctahedron(vec3 p, float s) {
  p = abs(p);
  return (p.x + p.y + p.z - s) * 0.57735027;
}

float sdBoxFrame(vec3 p, vec3 b, float e) {
  p = abs(p) - b;
  vec3 q = abs(p + e) - e;
  return min(min(
    length(max(vec3(p.x, q.y, q.z), 0.0)) + min(max(p.x, max(q.y, q.z)), 0.0),
    length(max(vec3(q.x, p.y, q.z), 0.0)) + min(max(q.x, max(p.y, q.z)), 0.0)),
    length(max(vec3(q.x, q.y, p.z), 0.0)) + min(max(q.x, max(q.y, p.z)), 0.0));
}

float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

vec2 mapLattice(vec3 p, float t) {
  vec3 q = p;
  q.z += t * 0.65;

  // Periodic machined lattice cell
  vec3 cellId = floor((q + 1.2) / 2.4);
  vec3 cell = mod(q + 1.2, 2.4) - 1.2;

  float frame = sdBoxFrame(cell, vec3(0.92), 0.065);

  vec3 coreP = cell;
  float phase = t * 0.65 + (cellId.x + cellId.y + cellId.z) * 0.45;
  coreP.xz *= rot2(phase);
  coreP.xy *= rot2(phase * 0.7);
  float octa = sdOctahedron(coreP, 0.42);

  // Structural struts along axes
  float strutX = length(cell.yz) - 0.055;
  float strutY = length(cell.xz) - 0.055;
  float struts = min(strutX, strutY);

  float chassis = smin(frame, struts, 0.08);
  if (octa < chassis) {
    return vec2(octa, 2.0);
  }
  return vec2(chassis, 1.0);
}

vec3 calcNormal(vec3 p, float t) {
  vec2 e = vec2(0.0018, 0.0);
  return normalize(vec3(
    mapLattice(p + e.xyy, t).x - mapLattice(p - e.xyy, t).x,
    mapLattice(p + e.yxy, t).x - mapLattice(p - e.yxy, t).x,
    mapLattice(p + e.yyx, t).x - mapLattice(p - e.yyx, t).x
  ));
}

float calcAO(vec3 p, vec3 n, float t) {
  float occ = 0.0;
  float w = 1.0;
  for (int i = 0; i < 4; i++) {
    float h = 0.04 + 0.14 * float(i);
    float d = mapLattice(p + n * h, t).x;
    occ += (h - d) * w;
    w *= 0.65;
  }
  return clamp(1.0 - 2.2 * occ, 0.0, 1.0);
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / max(u_resolution.y, 1.0);
  float t = u_time * max(u_speed, 0.0);

  vec3 ro = vec3(
    0.45 * sin(t * 0.35) + (u_mouse.x - 0.5) * 0.9,
    0.35 * cos(t * 0.28) + (u_mouse.y - 0.5) * 0.6,
    0.0
  );
  vec3 rd = normalize(vec3(uv, 1.35));
  rd.xy *= rot2(0.14 * sin(t * 0.22));
  rd.xz *= rot2(0.18 * cos(t * 0.19));

  float dist = 0.0;
  float matId = -1.0;
  float glowAccum = 0.0;

  for (int i = 0; i < 88; i++) {
    vec3 p = ro + rd * dist;
    vec2 h = mapLattice(p, t);
    if (h.y > 1.5) {
      glowAccum += 0.0035 / (0.045 + abs(h.x));
    }
    if (h.x < 0.0015) {
      matId = h.y;
      break;
    }
    dist += h.x * 0.92;
    if (dist > 22.0) break;
  }

  vec3 bg = vec3(0.012, 0.020, 0.016);
  vec3 col = bg;

  if (matId > 0.0) {
    vec3 p = ro + rd * dist;
    vec3 n = calcNormal(p, t);
    float ao = calcAO(p, n, t);

    vec3 l1 = normalize(vec3(0.6, 0.8, -0.5));
    vec3 l2 = normalize(vec3(-0.7, -0.3, 0.6));
    float diff1 = max(dot(n, l1), 0.0);
    float diff2 = max(dot(n, l2), 0.0);
    vec3 h1 = normalize(l1 - rd);
    float spec1 = pow(max(dot(n, h1), 0.0), 42.0);
    float fres = pow(1.0 - max(dot(n, -rd), 0.0), 3.0);

    if (matId < 1.5) {
      // Anodized slate-obsidian structural frame with subtle emerald edge sheen
      vec3 base = vec3(0.075, 0.115, 0.098);
      col = base * (0.18 + 0.95 * diff1) * ao;
      col += vec3(0.14, 0.34, 0.22) * diff2 * 0.35 * ao;
      col += vec3(0.55, 0.85, 0.68) * spec1 * 0.65;
      col += vec3(0.18, 0.68, 0.38) * fres * 0.38;
    } else {
      // Precision warm-amber + jade glowing core octahedron
      vec3 base = vec3(0.72, 0.45, 0.14);
      col = base * (0.35 + 0.9 * diff1) * ao;
      col += vec3(1.65, 0.96, 0.32) * (0.45 + spec1 * 1.25);
      col += vec3(0.32, 1.15, 0.65) * fres * 0.65;
    }

    float fog = 1.0 - exp(-0.018 * dist * dist);
    col = mix(col, bg, clamp(fog, 0.0, 1.0));
  }

  // Subtle volumetric amber-jade core scatter
  col += vec3(0.22, 0.72, 0.42) * min(glowAccum, 1.4) * 0.22;
  col += vec3(0.95, 0.56, 0.18) * min(glowAccum, 1.0) * 0.11;

  fragColor = vec4(col, 1.0);
}
`;

export const FLOW_FIELD_GLSL = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform vec2 u_resolution;
uniform float u_time;
uniform float u_speed;
uniform vec2 u_mouse;

float hash21(vec2 p) {
  p = fract(p * vec2(234.34, 435.345));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p) {
  float val = 0.0;
  float amp = 0.5;
  mat2 rot = mat2(0.80, -0.60, 0.60, 0.80);
  for (int i = 0; i < 5; i++) {
    val += amp * noise(p);
    p = rot * p * 2.03 + vec2(1.7, 9.2);
    amp *= 0.5;
  }
  return val;
}

// Analytic finite-difference curl of scalar potential fbm
vec2 curlField(vec2 p) {
  const float eps = 0.015;
  float n1 = fbm(p + vec2(0.0, eps));
  float n2 = fbm(p - vec2(0.0, eps));
  float n3 = fbm(p + vec2(eps, 0.0));
  float n4 = fbm(p - vec2(eps, 0.0));
  return vec2((n1 - n2) / (2.0 * eps), -(n3 - n4) / (2.0 * eps));
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / max(u_resolution.y, 1.0);
  float t = u_time * max(u_speed, 0.0) * 0.42;

  vec2 p = uv * 2.35 + (u_mouse - 0.5) * 0.65;

  // Two-stage domain warp using curl vector advection
  vec2 v1 = curlField(p + vec2(t * 0.35, -t * 0.22));
  vec2 q = p + v1 * 0.38;
  vec2 v2 = curlField(q * 1.25 - vec2(t * 0.28, t * 0.31));
  float potential = fbm(q + v2 * 0.44 + vec2(t * 0.18, 0.0));
  float speedMag = length(v2);

  // Topographic precision contour isolines
  float isoFreq = 16.0;
  float iso = abs(fract(potential * isoFreq - 0.5) - 0.5) / max(fwidth(potential * isoFreq), 0.002);
  float contour = 1.0 - smoothstep(0.0, 1.35, iso);

  // Fine engineering coordinate reticle
  vec2 gridUv = uv * 8.0;
  vec2 gridDist = abs(fract(gridUv - 0.5) - 0.5) / max(fwidth(gridUv), vec2(0.002));
  float gridLine = (1.0 - min(min(gridDist.x, gridDist.y), 1.0)) * 0.14;

  // Color ramp: deep obsidian -> slate pine -> bright emerald -> warm amber energy peaks
  vec3 obsidian = vec3(0.016, 0.026, 0.022);
  vec3 slate = vec3(0.055, 0.118, 0.092);
  vec3 emerald = vec3(0.14, 0.58, 0.34);
  vec3 jadeHot = vec3(0.45, 1.28, 0.74);
  vec3 amberHot = vec3(1.55, 0.92, 0.28);

  vec3 col = mix(obsidian, slate, smoothstep(0.18, 0.68, potential));
  col = mix(col, emerald, smoothstep(0.42, 0.85, potential) * 0.72);

  // Contour lines illuminated by curl shear magnitude
  float shearMask = smoothstep(0.65, 2.2, speedMag);
  vec3 lineColor = mix(jadeHot, amberHot, shearMask);
  col += lineColor * contour * (0.48 + 0.95 * shearMask);

  // Subtle velocity ridge highlights
  float ridge = smoothstep(1.35, 2.6, speedMag);
  col += amberHot * ridge * 0.38;

  // Subtle background engineering reticle
  col += vec3(0.14, 0.32, 0.22) * gridLine;

  fragColor = vec4(col, 1.0);
}
`;

export const BLOOM_EXTRACT_GLSL = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D u_sceneTex;
uniform vec2 u_texelSize;
uniform float u_bloomThreshold;

float luma(vec3 c) {
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

// Karis weight prevents single bright specular pixels from flickering during downsample
float karisWeight(vec3 c) {
  return 1.0 / (1.0 + luma(c));
}

vec3 softThreshold(vec3 c, float threshold) {
  float br = max(c.r, max(c.g, c.b));
  float knee = threshold * 0.5 + 0.0001;
  float soft = clamp(br - threshold + knee, 0.0, 2.0 * knee);
  soft = (soft * soft) / (4.0 * knee);
  float contrib = max(soft, br - threshold) / max(br, 0.0001);
  return c * max(contrib, 0.0);
}

void main() {
  vec2 d = u_texelSize;
  vec3 s0 = texture(u_sceneTex, vUv).rgb;
  vec3 s1 = texture(u_sceneTex, vUv + vec2(-d.x, -d.y)).rgb;
  vec3 s2 = texture(u_sceneTex, vUv + vec2( d.x, -d.y)).rgb;
  vec3 s3 = texture(u_sceneTex, vUv + vec2(-d.x,  d.y)).rgb;
  vec3 s4 = texture(u_sceneTex, vUv + vec2( d.x,  d.y)).rgb;

  vec3 t0 = softThreshold(s0, u_bloomThreshold);
  vec3 t1 = softThreshold(s1, u_bloomThreshold);
  vec3 t2 = softThreshold(s2, u_bloomThreshold);
  vec3 t3 = softThreshold(s3, u_bloomThreshold);
  vec3 t4 = softThreshold(s4, u_bloomThreshold);

  float w0 = karisWeight(t0) * 0.4;
  float w1 = karisWeight(t1) * 0.15;
  float w2 = karisWeight(t2) * 0.15;
  float w3 = karisWeight(t3) * 0.15;
  float w4 = karisWeight(t4) * 0.15;

  vec3 avg = (t0 * w0 + t1 * w1 + t2 * w2 + t3 * w3 + t4 * w4) / max(w0 + w1 + w2 + w3 + w4, 0.0001);
  fragColor = vec4(avg, 1.0);
}
`;

export const BLOOM_BLUR_GLSL = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D u_inputTex;
uniform vec2 u_direction;
uniform vec2 u_texelSize;

void main() {
  // 9-tap separable Gaussian kernel
  const float weights[5] = float[5](0.22702703, 0.19459459, 0.12162162, 0.05405405, 0.01621622);
  vec2 stepUv = u_direction * u_texelSize * 1.45;
  vec3 accum = texture(u_inputTex, vUv).rgb * weights[0];
  for (int i = 1; i < 5; i++) {
    vec2 offset = stepUv * float(i);
    accum += texture(u_inputTex, vUv + offset).rgb * weights[i];
    accum += texture(u_inputTex, vUv - offset).rgb * weights[i];
  }
  fragColor = vec4(accum, 1.0);
}
`;

export const TONEMAP_ACES_GLSL = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D u_sceneTex;
uniform sampler2D u_bloomTex;
uniform float u_bloomIntensity;
uniform float u_exposure;
uniform float u_bloomEnabled;
uniform float u_tonemapEnabled;

// Narkowicz 2015 ACES filmic tone mapping approximation
vec3 acesFilm(vec3 x) {
  const float a = 2.51;
  const float b = 0.03;
  const float c = 2.43;
  const float d = 0.59;
  const float e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

void main() {
  vec3 sceneCol = texture(u_sceneTex, vUv).rgb;
  vec3 bloomCol = texture(u_bloomTex, vUv).rgb;
  vec3 hdr = sceneCol + bloomCol * u_bloomIntensity * u_bloomEnabled;

  vec3 mapped;
  if (u_tonemapEnabled > 0.5) {
    hdr *= max(u_exposure, 0.01);
    mapped = acesFilm(hdr);
    // Subtle optical vignette
    vec2 centered = vUv * 2.0 - 1.0;
    float vig = 1.0 - dot(centered, centered) * 0.14;
    mapped *= clamp(vig, 0.72, 1.0);
    // Linear to sRGB gamma
    mapped = pow(max(mapped, vec3(0.0)), vec3(1.0 / 2.2));
  } else {
    mapped = clamp(hdr, 0.0, 1.0);
  }

  fragColor = vec4(mapped, 1.0);
}
`;

export const SHADER_PRESETS = [
  {
    id: 'pbr_sphere',
    name: 'PBR Material Sphere',
    filename: 'pbr_sphere.glsl',
    description: 'Analytic raymarched GGX PBR alloy sphere with amber gimbal ring, soft shadows, and optical bench grid.',
    source: PBR_SPHERE_GLSL,
  },
  {
    id: 'sdf_lattice',
    name: 'SDF Precision Lattice',
    filename: 'sdf_lattice.glsl',
    description: 'Infinite repeating machined signed-distance lattice with ambient occlusion and warm-amber octahedral cores.',
    source: SDF_LATTICE_GLSL,
  },
  {
    id: 'flow_field',
    name: 'Curl Flow Field',
    filename: 'flow_field.glsl',
    description: 'Two-stage curl-noise domain-warped contour field with topographic isolines and shear highlights.',
    source: FLOW_FIELD_GLSL,
  },
];

export const SHADER_PRESET_MAP = Object.fromEntries(
  SHADER_PRESETS.map((preset) => [preset.id, preset])
);

export const POST_SHADERS = {
  bloomExtract: {
    id: 'bloom_extract',
    name: 'Karis Bloom Extract',
    filename: 'bloom_extract.glsl',
    source: BLOOM_EXTRACT_GLSL,
  },
  bloomBlur: {
    id: 'bloom_blur',
    name: 'Separable Gaussian Blur',
    filename: 'bloom_blur.glsl',
    source: BLOOM_BLUR_GLSL,
  },
  tonemapAces: {
    id: 'tonemap_aces',
    name: 'ACES Filmic Tonemap',
    filename: 'tonemap_aces.glsl',
    source: TONEMAP_ACES_GLSL,
  },
};

export function getShaderPreset(id) {
  return SHADER_PRESET_MAP[id] || SHADER_PRESETS[0];
}
