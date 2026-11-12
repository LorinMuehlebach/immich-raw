// Minimal WebGL2 helpers: programs with cached uniform locations, textures, render targets.
import { VS_FULLSCREEN } from './shaders.ts';

export type UniformValue = number | boolean | readonly number[] | Float32Array | Int32Array;

export class Program {
  private locations = new Map<string, WebGLUniformLocation | null>();
  private types = new Map<string, number>();

  constructor(
    private gl: WebGL2RenderingContext,
    readonly handle: WebGLProgram,
  ) {
    const n = gl.getProgramParameter(handle, gl.ACTIVE_UNIFORMS) as number;
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(handle, i);
      if (info) this.types.set(info.name.replace(/\[0\]$/, ''), info.type);
    }
  }

  private loc(name: string) {
    if (!this.locations.has(name)) this.locations.set(name, this.gl.getUniformLocation(this.handle, name));
    return this.locations.get(name)!;
  }

  use(): this {
    this.gl.useProgram(this.handle);
    return this;
  }

  /** The texture target a sampler uniform reads (TEXTURE_3D for sampler3D, else TEXTURE_2D). */
  samplerTarget(name: string): number {
    return this.types.get(name) === this.gl.SAMPLER_3D ? this.gl.TEXTURE_3D : this.gl.TEXTURE_2D;
  }

  /** Does the (linked) program use this uniform? */
  has(name: string): boolean {
    return this.types.has(name);
  }

  /** Sets uniforms by name; unknown names are ignored (the compiler may drop unused ones). */
  set(values: Record<string, UniformValue>): this {
    const gl = this.gl;
    for (const [name, value] of Object.entries(values)) {
      const loc = this.loc(name);
      const type = this.types.get(name);
      if (!loc || type === undefined) continue;
      const v = typeof value === 'boolean' ? Number(value) : value;
      switch (type) {
        case gl.FLOAT:
          if (typeof v === 'number') gl.uniform1f(loc, v);
          else gl.uniform1fv(loc, v as Float32List);
          break;
        case gl.FLOAT_VEC2:
          gl.uniform2fv(loc, v as Float32List);
          break;
        case gl.FLOAT_VEC3:
          gl.uniform3fv(loc, v as Float32List);
          break;
        case gl.FLOAT_VEC4:
          gl.uniform4fv(loc, v as Float32List);
          break;
        case gl.FLOAT_MAT3:
          gl.uniformMatrix3fv(loc, false, v as Float32List);
          break;
        case gl.INT:
        case gl.BOOL:
        case gl.SAMPLER_2D:
        case gl.SAMPLER_3D:
        case gl.UNSIGNED_INT_SAMPLER_2D:
          gl.uniform1i(loc, v as number);
          break;
        case gl.INT_VEC2:
          gl.uniform2iv(loc, v as Int32List);
          break;
        case gl.INT_VEC4:
          gl.uniform4iv(loc, v as Int32List);
          break;
        default:
          throw new Error(`Unsupported uniform type for ${name}`);
      }
    }
    return this;
  }
}

export interface Target {
  tex: WebGLTexture;
  fb: WebGLFramebuffer;
  width: number;
  height: number;
  format: number;
}

export class GLContext {
  readonly gl: WebGL2RenderingContext;
  private vao: WebGLVertexArrayObject;
  private vs: WebGLShader;
  /** Textures bound for every program that declares the sampler (e.g. the brush masks). */
  private shared = new Map<string, WebGLTexture>();

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    if (!gl.getExtension('EXT_color_buffer_float')) {
      throw new Error('This browser cannot render to floating-point textures (EXT_color_buffer_float).');
    }
    this.vao = gl.createVertexArray()!;
    this.vs = this.shader(gl.VERTEX_SHADER, VS_FULLSCREEN);
  }

  private shader(type: number, src: string): WebGLShader {
    const gl = this.gl;
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error(`Shader compile failed: ${log}`);
    }
    return sh;
  }

  program(fs: string): Program {
    const gl = this.gl;
    const prog = gl.createProgram()!;
    gl.attachShader(prog, this.vs);
    gl.attachShader(prog, this.shader(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`Program link failed: ${gl.getProgramInfoLog(prog)}`);
    return new Program(gl, prog);
  }

  texture(
    width: number,
    height: number,
    internalFormat: number,
    opts: { filter?: number; mipmaps?: boolean } = {},
  ): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    const levels = opts.mipmaps ? Math.floor(Math.log2(Math.max(width, height))) + 1 : 1;
    gl.texStorage2D(gl.TEXTURE_2D, levels, internalFormat, width, height);
    const filter = opts.filter ?? gl.LINEAR;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, opts.mipmaps ? gl.LINEAR_MIPMAP_LINEAR : filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  /**
   * A filtered RGBA16F 3D texture from RGBA float data (x fastest, then y, then z): look
   * tables and colour LUTs. `repeatY` wraps the y axis (a look table's hue).
   */
  texture3d(width: number, height: number, depth: number, rgba: Float32Array, opts: { repeatY?: boolean } = {}): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_3D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA16F, width, height, depth, 0, gl.RGBA, gl.FLOAT, rgba);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, opts.repeatY ? gl.REPEAT : gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    return tex;
  }

  target(width: number, height: number, internalFormat: number, opts: { filter?: number; mipmaps?: boolean } = {}): Target {
    const gl = this.gl;
    const tex = this.texture(width, height, internalFormat, opts);
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`Framebuffer incomplete (0x${status.toString(16)})`);
    return { tex, fb, width, height, format: internalFormat };
  }

  deleteTarget(t: Target | null | undefined): void {
    if (!t) return;
    this.gl.deleteFramebuffer(t.fb);
    this.gl.deleteTexture(t.tex);
  }

  /** Reuses `t` if it already has this size and format, otherwise replaces it. */
  ensureTarget(t: Target | null, width: number, height: number, internalFormat: number, opts: { filter?: number; mipmaps?: boolean } = {}): Target {
    if (t && t.width === width && t.height === height && t.format === internalFormat) return t;
    this.deleteTarget(t);
    return this.target(width, height, internalFormat, opts);
  }

  /** Makes `tex` available as sampler `name` to every program that declares it (null removes it). */
  setShared(name: string, tex: WebGLTexture | null): void {
    if (tex) this.shared.set(name, tex);
    else this.shared.delete(name);
  }

  /** Binds textures to units 0..n in order and draws a fullscreen triangle into `target` (null = canvas). */
  draw(program: Program, target: Target | null, textures: Record<string, WebGLTexture>, uniforms: Record<string, Parameters<Program['set']>[0][string]> = {}, viewport?: [number, number, number, number]): void {
    const gl = this.gl;
    program.use();
    let unit = 0;
    const samplers: Record<string, number> = {};
    for (const [name, tex] of Object.entries(textures)) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(program.samplerTarget(name), tex);
      samplers[name] = unit++;
    }
    for (const [name, tex] of this.shared) {
      if (name in samplers || !program.has(name)) continue;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(program.samplerTarget(name), tex);
      samplers[name] = unit++;
    }
    program.set({ ...samplers, ...uniforms });
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
    if (viewport) gl.viewport(...viewport);
    else if (target) gl.viewport(0, 0, target.width, target.height);
    else gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
