/**
 * A watercolour painting made fresh from a seed (Anil, 2026-11-19: "we can generate a new artwork everytime"), for
 * /__accounts-signin's "Watercolour" look. WebGPU through components/landing/figma-shader, like the landing's Columns.
 *
 * Each wash is a blob warped by noise. Pigment pools at its rim (the dark edge watercolour dries with), the paper's
 * grain catches it (granulation), and drying leaves tide lines inside. Washes mix as paint does, not as light: each one
 * absorbs some of the light (Beer–Lambert), so blue over yellow turns green, not grey. No library and no licence.
 */
import type { CustomEffectState as Frame, Shader } from "@/components/landing/figma-shader/types";

const wgsl = `diagnostic(off,derivative_uniformity);
struct Uniforms {
  dims: vec4f,   // width, height, seed, washes
  paper: vec4f,  // rgb
  p0: vec4f,     // pigment rgb (its colour at full strength), strength
  p1: vec4f,
  p2: vec4f,
  opts: vec4f,   // clear x, clear y (0..1), clear radius (of the height), grain
};
@group(0) @binding(0) var<uniform> u: Uniforms;

struct VsIn { @location(0) pos: vec2f, @location(1) uv: vec2f };
struct VsOut { @builtin(position) position: vec4f, @location(0) uv: vec2f };

@vertex fn vs_main(inp: VsIn) -> VsOut {
  var o: VsOut;
  o.position = vec4f(inp.pos, 0.0, 1.0);
  o.uv = inp.uv;
  return o;
}

fn hash1(n: f32) -> f32 { return fract(sin(n * 91.3458) * 47453.5453); }
fn hash2(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453); }

fn vnoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let w = f * f * (vec2f(3.0) - 2.0 * f);
  return mix(mix(hash2(i), hash2(i + vec2f(1.0, 0.0)), w.x), mix(hash2(i + vec2f(0.0, 1.0)), hash2(i + vec2f(1.0, 1.0)), w.x), w.y);
}

fn fbm(p: vec2f) -> f32 {
  var total = 0.0;
  var amp = 0.5;
  var q = p;
  for (var k = 0; k < 5; k = k + 1) {
    total = total + amp * vnoise(q);
    q = q * 2.02 + vec2f(17.0, 9.0);
    amp = amp * 0.5;
  }
  return total;
}

fn pigment(i: i32) -> vec4f {
  let k = i % 3;
  return select(select(u.p2, u.p1, k == 1), u.p0, k == 0);
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let res = max(u.dims.xy, vec2f(1.0));
  let px = uv * res;
  // Height-relative coordinates, so the painting is the same at any size or pixel density.
  let p = (px - 0.5 * res) / res.y;
  let aspect = res.x / res.y;
  // CSS-ish pixels for the paper's fine texture.
  let fine = px / (res.y / 900.0);
  let seed = u.dims.z;

  // The middle stays lighter, where the card sits.
  let clearC = vec2f((u.opts.x - 0.5) * aspect, u.opts.y - 0.5);
  let clear = smoothstep(u.opts.z * 0.6, u.opts.z * 1.6, length((p - clearC) * vec2f(0.8, 1.0)));

  var absorb = vec3f(0.0);
  for (var i = 0; i < 9; i = i + 1) {
    if (f32(i) >= u.dims.w) { break; }
    let s = seed * 7.13 + f32(i) * 19.37;
    let c = vec2f((hash1(s) - 0.5) * aspect * 1.05, (hash1(s + 1.7) - 0.5) * 1.05);
    let r = 0.2 + 0.28 * hash1(s + 3.1);
    let stretch = vec2f(1.0 + 0.8 * hash1(s + 4.4), 1.0);
    let q = (p - c) * stretch;
    let warp = vec2f(fbm(p * 2.1 + vec2f(s, 0.0)), fbm(p * 2.1 + vec2f(0.0, s + 5.2))) - vec2f(0.5);
    let d = length(q + warp * r * 0.9) / r;
    let ragged = (fbm(p * 9.0 + vec2f(s * 1.3)) - 0.5) * 0.22;
    let edge = 0.9 + ragged;
    // A crisp but not hard edge, as paint dries on paper.
    let inside = 1.0 - smoothstep(edge - 0.025, edge + 0.01, d);
    // Pigment pools at the rim.
    let rim = smoothstep(edge - 0.32, edge - 0.01, d) * inside;
    // Uneven flow inside, and tide lines where it dried in stages.
    let flow = 0.45 + 0.55 * fbm(p * 3.2 + vec2f(s * 2.0, s));
    let level = fract(fbm(p * 1.6 + vec2f(s * 0.7)) * 3.0 + hash1(s + 9.0));
    let tide = 1.0 + 0.35 * (1.0 - smoothstep(0.0, 0.06, level)) - 0.12 * smoothstep(0.06, 0.4, level);
    // Granulation: pigment settles in the paper's tooth.
    let gran = vnoise(fine * 0.55 + vec2f(s)) * 0.6 + vnoise(fine * 1.7) * 0.4;
    let dens = inside * (0.5 * flow * tide + 0.9 * rim) * (0.7 + 0.6 * gran * u.opts.w + (1.0 - u.opts.w) * 0.3);
    let pg = pigment(i);
    let weight = 0.55 + 0.45 * hash1(s + 6.6);
    absorb = absorb - log(max(pg.rgb, vec3f(0.03))) * dens * pg.a * weight * mix(0.35, 1.0, clear);
  }

  // Paper: a cold-press tooth and a faint fibre, under the paint.
  let tooth = fbm(fine * 0.09) * 0.035 + (hash2(floor(fine)) - 0.5) * 0.018;
  let paper = u.paper.rgb * (1.0 - tooth);
  let rgb = paper * exp(-absorb);
  return vec4f(rgb, 1.0);
}
`;

function setup(device: GPUDevice, frame: Frame) {
  frame.state.module = device.createShaderModule({ code: wgsl });
  frame.state.pipeline = null;
  frame.state.pipelineFormat = null;
  const quad = device.createBuffer({ size: 6 * 4 * 4, usage: GPUBufferUsage.VERTEX, mappedAtCreation: true });
  new Float32Array(quad.getMappedRange()).set([-1, -1, 0, 1, 1, -1, 1, 1, -1, 1, 0, 0, -1, 1, 0, 0, 1, -1, 1, 1, 1, 1, 1, 0]);
  quad.unmap();
  frame.state.quad = quad;
  frame.state.uniforms = device.createBuffer({ size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
}

type Rgb = readonly [number, number, number];
type Pigment = readonly [number, number, number, number];

function render(device: GPUDevice, frame: Frame) {
  const output = frame.output;
  if (!output) return;
  const params = frame.params as { seed: number; washes: number; paper: Rgb; pigments: readonly [Pigment, Pigment, Pigment]; clear: readonly [number, number, number]; grain: number };
  const [a, b, c] = params.pigments;
  device.queue.writeBuffer(frame.state.uniforms as GPUBuffer, 0, new Float32Array([
    output.width, output.height, params.seed, params.washes,
    ...params.paper, 1,
    ...a, ...b, ...c,
    ...params.clear, params.grain,
  ]));
  if (frame.state.pipeline == null || frame.state.pipelineFormat !== output.format) {
    const shaderModule = frame.state.module as GPUShaderModule;
    frame.state.pipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: { module: shaderModule, entryPoint: "vs_main", buffers: [{ arrayStride: 16, attributes: [{ shaderLocation: 0, format: "float32x2", offset: 0 }, { shaderLocation: 1, format: "float32x2", offset: 8 }] }] },
      fragment: { module: shaderModule, entryPoint: "fs_main", targets: [{ format: output.format }] },
      primitive: { topology: "triangle-list" },
    });
    frame.state.pipelineFormat = output.format;
  }
  const pipeline = frame.state.pipeline as GPURenderPipeline;
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({ colorAttachments: [{ view: output.createView(), loadOp: "clear", clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: "store" }] });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: frame.state.uniforms as GPUBuffer } }] }));
  pass.setVertexBuffer(0, frame.state.quad as GPUBuffer);
  pass.draw(6);
  pass.end();
  device.queue.submit([encoder.finish()]);
}

/** Pigments as their colour at full strength (what they let through), and how strongly they stain. */
const PIGMENT = {
  ultramarine: [0.32, 0.42, 0.86, 0.9],
  cerulean: [0.52, 0.76, 0.9, 0.85],
  rose: [0.94, 0.52, 0.66, 0.8],
  gamboge: [0.98, 0.8, 0.36, 0.85],
  sapGreen: [0.55, 0.72, 0.38, 0.8],
  viridian: [0.4, 0.72, 0.64, 0.8],
  violet: [0.62, 0.5, 0.82, 0.8],
  sienna: [0.86, 0.56, 0.4, 0.8],
  ochre: [0.94, 0.8, 0.52, 0.8],
  indigo: [0.42, 0.46, 0.62, 0.75],
} as const satisfies Record<string, Pigment>;

/** Palettes a painter would lay out: three pigments that mix well. */
export const PALETTES = [
  { name: "Blue hour", pigments: [PIGMENT.ultramarine, PIGMENT.cerulean, PIGMENT.rose] },
  { name: "Garden", pigments: [PIGMENT.sapGreen, PIGMENT.gamboge, PIGMENT.cerulean] },
  { name: "Dusk", pigments: [PIGMENT.rose, PIGMENT.gamboge, PIGMENT.violet] },
  { name: "Sea", pigments: [PIGMENT.cerulean, PIGMENT.viridian, PIGMENT.ultramarine] },
  { name: "Earth", pigments: [PIGMENT.sienna, PIGMENT.ochre, PIGMENT.indigo] },
] as const;

/** A painting from a seed: the seed picks the palette, the number of washes and where they fall. */
export function watercolourShader(seed: number): Shader {
  const palette = PALETTES[Math.floor(seed * 7919) % PALETTES.length]!;
  return {
    setup,
    render,
    manifest: { isAnimated: false, name: "Watercolour", usesMouse: false, version: 1 },
    params: { seed: seed * 100, washes: 6 + (Math.floor(seed * 104729) % 3), paper: [0.992, 0.986, 0.972], pigments: palette.pigments, clear: [0.5, 0.5, 0.42], grain: 0.9 },
  };
}

export function paletteName(seed: number) {
  return PALETTES[Math.floor(seed * 7919) % PALETTES.length]!.name;
}
