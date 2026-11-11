// M0 WebGL2 spike: half-size decode -> RGBA16F proxy (<= 2560 px) -> edit shader.
// Measures GPU time per frame for the edit pass alone and with extra blur passes that
// approximate the real pipeline's multiscale work.
import LibRaw from 'libraw-wasm';

const PROXY_LONG_SIDE = 2560;
const log = (s) => {
  document.getElementById('log').textContent += s + '\n';
  console.log(s);
};

const VS = `#version 300 es
in vec2 p; out vec2 uv;
void main() { uv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }`;

// Box-average downsample of the camera-RGB source into the RGBA16F proxy.
const FS_DOWNSAMPLE = `#version 300 es
precision highp float;
uniform highp sampler2D src; uniform vec2 scale; uniform float comp;
in vec2 uv; out vec4 o;
void main() {
  ivec2 size = textureSize(src, 0);
  ivec2 base = ivec2(floor(gl_FragCoord.xy * scale));
  int n = int(ceil(scale.x));
  vec3 acc = vec3(0.0); float cnt = 0.0;
  for (int y = 0; y < 8; y++) { if (y >= n) break;
    for (int x = 0; x < 8; x++) { if (x >= n) break;
      ivec2 t = min(base + ivec2(x, y), size - 1);
      acc += texelFetch(src, ivec2(t.x, size.y - 1 - t.y), 0).rgb; cnt += 1.0; } }
  o = vec4(acc / cnt * comp, 1.0);
}`;

// Separable 31-tap Gaussian, used only to simulate multiscale cost.
const FS_BLUR = `#version 300 es
precision highp float;
uniform sampler2D src; uniform vec2 dir;
in vec2 uv; out vec4 o;
void main() {
  vec4 acc = vec4(0.0); float wsum = 0.0;
  for (int i = -15; i <= 15; i++) { float w = exp(-float(i * i) / 50.0);
    acc += texture(src, uv + dir * float(i)) * w; wsum += w; }
  o = acc / wsum;
}`;

// WB ratio -> camera->sRGB matrix -> exposure -> contrast -> filmic shoulder -> sRGB.
const FS_EDIT = `#version 300 es
precision highp float;
uniform sampler2D proxy; uniform sampler2D blurred;
uniform vec3 wb; uniform mat3 camToSrgb; uniform float ev; uniform float contrast; uniform float useBlur;
in vec2 uv; out vec4 o;
vec3 filmic(vec3 x) { return x * (1.0 + x / 16.0) / (1.0 + x); }
float enc(float v) { v = clamp(v, 0.0, 1.0);
  return v <= 0.0031308 ? 12.92 * v : 1.055 * pow(v, 1.0 / 2.4) - 0.055; }
void main() {
  vec3 cam = texture(proxy, uv).rgb;
  if (useBlur > 0.5) cam = mix(cam, texture(blurred, uv).rgb, 0.001);
  vec3 lin = camToSrgb * (cam * wb) * exp2(ev + 1.0);
  vec3 lg = log2(max(lin, 1e-6) / 0.18) * (1.0 + contrast) ;
  lin = 0.18 * exp2(lg);
  vec3 c = filmic(lin);
  o = vec4(enc(c.r), enc(c.g), enc(c.b), 1.0);
}`;

function compile(gl, vs, fs) {
  const prog = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
    gl.attachShader(prog, sh);
  }
  gl.bindAttribLocation(prog, 0, 'p');
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  return prog;
}

function target(gl, w, h) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, w, h);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('RGBA16F FBO incomplete');
  return { tex, fb, w, h };
}

async function main() {
  const file = new URLSearchParams(location.search).get('file') ?? 'sony-a7rv.ARW';
  const bytes = new Uint8Array(await (await fetch(`/samples/${file}`)).arrayBuffer());
  const raw = new LibRaw();
  const t0 = performance.now();
  await raw.open(bytes, {
    outputColor: 0, outputBps: 16, gamm: [1, 1, 0, 0, 0, 0], noAutoBright: true,
    useCameraWb: true, userFlip: 0, highlight: 1, halfSize: true,
  });
  const meta = await raw.metadata(true);
  const img = await raw.imageData();
  raw.dispose();
  log(`${file}: half decode ${(performance.now() - t0).toFixed(0)} ms, ${img.width}x${img.height}`);

  const canvas = document.getElementById('c');
  const scale = Math.max(img.width, img.height) / PROXY_LONG_SIDE;
  const pw = Math.round(img.width / Math.max(1, scale));
  const ph = Math.round(img.height / Math.max(1, scale));
  canvas.width = pw;
  canvas.height = ph;
  const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true });
  if (!gl) throw new Error('WebGL2 not available');
  if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('EXT_color_buffer_float missing');
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  const timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  log(`renderer: ${renderer}; timer query: ${!!timer}; max texture ${gl.getParameter(gl.MAX_TEXTURE_SIZE)}`);

  // Upload: Uint16 RGB -> Float32 RGB texture (normalised to 0..1).
  const t1 = performance.now();
  const f32 = new Float32Array(img.data.length);
  for (let i = 0; i < f32.length; i++) f32[i] = img.data[i] / 65535;
  const src = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, src);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB32F, img.width, img.height, 0, gl.RGB, gl.FLOAT, f32);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  const color = meta.color_data;
  const mul = color.cam_mul.slice(0, 3);
  const comp = Math.max(...mul) / Math.min(...mul);
  const proxy = target(gl, pw, ph);
  const progDown = compile(gl, VS, FS_DOWNSAMPLE);
  gl.useProgram(progDown);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, src);
  gl.uniform1i(gl.getUniformLocation(progDown, 'src'), 0);
  gl.uniform2f(gl.getUniformLocation(progDown, 'scale'), img.width / pw, img.height / ph);
  gl.uniform1f(gl.getUniformLocation(progDown, 'comp'), comp);
  gl.bindFramebuffer(gl.FRAMEBUFFER, proxy.fb);
  gl.viewport(0, 0, pw, ph);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.finish();
  gl.deleteTexture(src);
  log(`upload + proxy build ${(performance.now() - t1).toFixed(0)} ms -> proxy ${pw}x${ph} RGBA16F`);

  const tmpA = target(gl, pw, ph);
  const tmpB = target(gl, pw, ph);
  const progBlur = compile(gl, VS, FS_BLUR);
  const progEdit = compile(gl, VS, FS_EDIT);
  const M = color.rgb_cam.map((r) => r.slice(0, 3));
  const camToSrgb = new Float32Array([M[0][0], M[1][0], M[2][0], M[0][1], M[1][1], M[2][1], M[0][2], M[1][2], M[2][2]]);

  function render({ wbShift = 0, ev = 0, contrast = 0, blurPasses = 0 }) {
    let input = proxy;
    if (blurPasses > 0) {
      gl.useProgram(progBlur);
      gl.uniform1i(gl.getUniformLocation(progBlur, 'src'), 0);
      for (let i = 0; i < blurPasses; i++) {
        const out = i % 2 === 0 ? tmpA : tmpB;
        gl.bindFramebuffer(gl.FRAMEBUFFER, out.fb);
        gl.bindTexture(gl.TEXTURE_2D, input.tex);
        gl.uniform2f(gl.getUniformLocation(progBlur, 'dir'), i % 2 ? 0 : 1 / pw, i % 2 ? 1 / ph : 0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        input = out;
      }
    }
    gl.useProgram(progEdit);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, proxy.tex);
    gl.uniform1i(gl.getUniformLocation(progEdit, 'proxy'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, input.tex);
    gl.uniform1i(gl.getUniformLocation(progEdit, 'blurred'), 1);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform3f(gl.getUniformLocation(progEdit, 'wb'), 1 + wbShift * 0.3, 1, 1 - wbShift * 0.3);
    gl.uniformMatrix3fv(gl.getUniformLocation(progEdit, 'camToSrgb'), false, camToSrgb);
    gl.uniform1f(gl.getUniformLocation(progEdit, 'ev'), ev);
    gl.uniform1f(gl.getUniformLocation(progEdit, 'contrast'), contrast);
    gl.uniform1f(gl.getUniformLocation(progEdit, 'useBlur'), blurPasses > 0 ? 1 : 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // Time N frames; readPixels of one pixel forces each frame to finish.
  const px = new Uint8Array(4);
  function bench(blurPasses, frames = 60) {
    render({ blurPasses });
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const t = performance.now();
    for (let i = 0; i < frames; i++) {
      render({ wbShift: Math.sin(i / 10), ev: Math.sin(i / 7), contrast: 0.2, blurPasses });
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    }
    const ms = (performance.now() - t) / frames;
    return { blurPasses, msPerFrame: +ms.toFixed(2), fps: Math.round(1000 / ms) };
  }

  const results = { file, proxy: [pw, ph], renderer, runs: [bench(0), bench(12)] };
  for (const r of results.runs) log(`edit + ${r.blurPasses} blur passes: ${r.msPerFrame} ms/frame (${r.fps} fps)`);

  render({});
  results.screenshot = canvas.toDataURL('image/jpeg', 0.85);
  for (const id of ['wb', 'ev', 'contrast']) {
    document.getElementById(id).addEventListener('input', () =>
      requestAnimationFrame(() =>
        render({
          wbShift: +document.getElementById('wb').value,
          ev: +document.getElementById('ev').value,
          contrast: +document.getElementById('contrast').value,
        }),
      ),
    );
  }
  window.__gpuResults = results;
  window.__done = true;
}

main().catch((e) => {
  log(`FATAL ${e?.stack ?? e}`);
  window.__gpuResults = { fatal: String(e) };
  window.__done = true;
});
