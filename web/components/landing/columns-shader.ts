// Silicon backdrop, Columns style, from the landing framework hero (Figma node 72:39).
import type { CustomEffectState as Frame, Shader } from "./figma-shader/types";

const wgsl = `diagnostic(off,derivative_uniformity);
struct Uniforms {
  paper: vec4f,
  hue: vec4f,
  dims: vec4f,
  clearz: vec4f,
  look: vec4f,
};
@group(0) @binding(0) var<uniform> u: Uniforms;

struct VsIn {
  @location(0) pos: vec2f,
  @location(1) uv: vec2f,
};
struct VsOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@vertex fn vs_main(inp: VsIn) -> VsOut {
  var o: VsOut;
  o.position = vec4f(inp.pos, 0.0, 1.0);
  o.uv = inp.uv;
  return o;
}

fn hash2(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453);
}

fn vnoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let w = f * f * (vec2f(3.0, 3.0) - 2.0 * f);
  let a = hash2(i);
  let b = hash2(i + vec2f(1.0, 0.0));
  let c = hash2(i + vec2f(0.0, 1.0));
  let d = hash2(i + vec2f(1.0, 1.0));
  return mix(mix(a, b, w.x), mix(c, d, w.x), w.y);
}

fn fbm(p: vec2f) -> f32 {
  var total = 0.0;
  var amp = 0.55;
  var q = p;
  for (var k = 0; k < 4; k = k + 1) {
    total = total + amp * vnoise(q);
    q = q * 2.03 + vec2f(17.0, 9.0);
    amp = amp * 0.5;
  }
  return total;
}

fn field(px: vec2f) -> f32 {
  let s = max(u.look.z, 1.0);
  let o = vec2f(u.look.y * 13.7, u.look.y * 7.3);
  return fbm(px / s + o);
}

fn clearDist(px: vec2f) -> f32 {
  let h = max(u.dims.y, 1.0);
  let p = px / h;
  let c = vec2f(u.clearz.x * u.dims.x / h, u.clearz.y);
  return length(p - c);
}

fn clearMask(px: vec2f) -> f32 {
  return smoothstep(u.clearz.z, u.clearz.z + max(u.clearz.w, 0.001), clearDist(px));
}

fn ramp(t: f32) -> vec3f {
  let c0 = u.paper.rgb;
  let c1 = mix(u.paper.rgb, u.hue.rgb, 0.28);
  let c2 = u.hue.rgb;
  let c3 = u.hue.rgb * 0.72;
  let a = mix(c0, c1, clamp(t / 0.4, 0.0, 1.0));
  let b = mix(c1, c2, clamp((t - 0.4) / 0.4, 0.0, 1.0));
  let c = mix(c2, c3, clamp((t - 0.8) / 0.2, 0.0, 1.0));
  return select(select(c, b, t < 0.8), a, t < 0.4);
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let px = uv * u.dims.xy;
  let style = u.dims.z;
  var t = 0.0;

  if (style < 0.5) {
    let f = field(px);
    t = clearMask(px) * smoothstep(0.30, 0.80, f);
  } else if (style < 1.5) {
    let cell = max(u.look.x, 4.0);
    let cid = floor(px / cell);
    let cc = (cid + vec2f(0.5, 0.5)) * cell;
    let f = field(cc);
    let j = hash2(cid + vec2f(u.look.y, 3.0)) - 0.5;
    var v = clearMask(cc) * clamp(smoothstep(0.30, 0.80, f) + j * 0.35, 0.0, 1.0);
    v = floor(v * 6.0) / 6.0;
    t = v;
  } else if (style < 2.5) {
    let f = field(px * 0.6);
    let m = clearMask(px);
    let g = hash2(floor(px)) - 0.5;
    t = clamp(m * pow(smoothstep(0.20, 0.85, f), 1.2) + g * u.look.w * m, 0.0, 1.0);
  } else {
    let cw = max(u.look.x, 8.0);
    let ch = max(cw * 0.28, 4.0);
    let ci = floor(px.x / cw);
    let ri = floor(px.y / ch);
    let cc = vec2f((ci + 0.5) * cw, (ri + 0.5) * ch);
    let energy = 0.6 + 0.4 * hash2(vec2f(ci, u.look.y + 5.0));
    let drift = vnoise(vec2f(ci * 0.9 + u.look.y * 0.37, cc.y / max(u.look.z, 1.0)));
    let build = smoothstep(u.clearz.z, u.clearz.z + max(u.clearz.w, 0.001) * 1.6, clearDist(cc));
    let jit = (hash2(vec2f(ci + 0.5, ri + u.look.y)) - 0.5) * 0.08;
    var v = build * (energy * (0.55 + 0.45 * drift) + jit);
    v = clamp(v, 0.0, 1.0);
    t = floor(v * 18.0) / 18.0;
  }

  t = clamp(t * u.dims.w, 0.0, 1.0);
  var rgb = vec3f(0.0, 0.0, 0.0);
  if (style > 2.5) {
    rgb = ramp(t);
  } else {
    let light = mix(u.paper.rgb, u.hue.rgb, 0.35);
    let deep = mix(light, u.hue.rgb, smoothstep(0.35, 1.0, t));
    rgb = mix(u.paper.rgb, deep, smoothstep(0.0, 0.6, t));
  }
  return vec4f(rgb, 1.0);
}
`;

export function setup(device: GPUDevice, frame: Frame) {
  frame.state.module = device.createShaderModule({ code: wgsl });
  frame.state.pipeline = null;
  frame.state.pipelineFormat = null;
  frame.state.quad = device.createBuffer({
    size: 6 * 4 * 4,
    usage: GPUBufferUsage.VERTEX,
    mappedAtCreation: true,
  });
  new Float32Array((frame.state.quad as GPUBuffer).getMappedRange()).set([
    -1, -1, 0, 1,
    1, -1, 1, 1,
    -1, 1, 0, 0,
    -1, 1, 0, 0,
    1, -1, 1, 1,
    1, 1, 1, 0,
  ]);
  (frame.state.quad as GPUBuffer).unmap();
  frame.state.uniforms = device.createBuffer({
    size: 80,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
}

function num(v: unknown, fallback: number) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function ch(color: unknown, channel: string, fallback: number) {
  return num(color && typeof color === "object" ? (color as Record<string, unknown>)[channel] : undefined, fallback);
}

export function render(device: GPUDevice, frame: Frame) {
  const output = frame.output;
  if (!output) return;
  const params = frame.params ?? {};
  const paper = params.paper;
  const hue = params.hue;
  device.queue.writeBuffer(frame.state.uniforms as GPUBuffer, 0, new Float32Array([
    ch(paper, "r", 0.988), ch(paper, "g", 0.988), ch(paper, "b", 0.988), 1,
    ch(hue, "r", 0.227), ch(hue, "g", 0.427), ch(hue, "b", 0.94), 1,
    output.width, output.height, num(params.style, 0), num(params.intensity, 0.85),
    num(params.clearX, 25) / 100, num(params.clearY, 45) / 100, num(params.clearRadius, 45) / 100, num(params.softness, 35) / 100,
    num(params.cellSize, 40), num(params.seed, 1), num(params.scale, 420), num(params.grain, 0.12),
  ]));
  const outputFormat = output.format;
  if (frame.state.pipeline == null || frame.state.pipelineFormat !== outputFormat) {
    frame.state.pipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: frame.state.module as GPUShaderModule,
        entryPoint: "vs_main",
        buffers: [{
          arrayStride: 16,
          attributes: [
            { shaderLocation: 0, format: "float32x2", offset: 0 },
            { shaderLocation: 1, format: "float32x2", offset: 8 },
          ],
        }],
      },
      fragment: {
        module: frame.state.module as GPUShaderModule,
        entryPoint: "fs_main",
        targets: [{ format: outputFormat }],
      },
      primitive: { topology: "triangle-list" },
    });
    frame.state.pipelineFormat = outputFormat;
  }
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [{
      view: output.createView(),
      loadOp: "clear",
      clearValue: { r: 0, g: 0, b: 0, a: 0 },
      storeOp: "store",
    }],
  });
  const pipeline = frame.state.pipeline as GPURenderPipeline;
  pass.setPipeline(pipeline);
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: frame.state.uniforms as GPUBuffer } }],
  });
  pass.setBindGroup(0, bindGroup);
  pass.setVertexBuffer(0, frame.state.quad as GPUBuffer);
  pass.draw(6);
  pass.end();
  device.queue.submit([encoder.finish()]);
}

export const manifest = {
  isAnimated: false,
  name: "Silicon backdrop",
  usesMouse: false,
  version: 2,
};

const hue = { r: 0.12156862765550613, g: 0.3607843220233917, b: 0.6941176652908325, a: 1 };
const paper = { r: 0.9879999756813049, g: 0.9879999756813049, b: 0.9879999756813049, a: 1 };

export const columnsShader: Shader = {
  setup,
  render,
  manifest,
  params: { hue, paper, clearY: 70, softness: 60, intensity: 1.1, grain: 0, clearX: 18, clearRadius: 64, cellSize: 88, seed: 9, scale: 340, style: 3 },
};

export const accentShader: Shader = {
  setup,
  render,
  manifest,
  params: { hue, paper, clearY: 100, softness: 40, intensity: 0.75, grain: 0, clearX: 100, clearRadius: 5, cellSize: 84, seed: 21, scale: 300, style: 3 },
};

/** How it works stage (Figma node 93:137): Columns, centred clear, intensity 0.85. */
export const stageShader: Shader = {
  setup,
  render,
  manifest,
  params: { hue, paper, clearY: 50, softness: 70, intensity: 0.85, grain: 0, clearX: 50, clearRadius: 28, cellSize: 64, seed: 11, scale: 300, style: 3 },
};
