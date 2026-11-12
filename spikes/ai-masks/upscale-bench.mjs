// Speed of the AI upscaler candidates on onnxruntime-web's WASM backend (the plain-HTTP path).
// node spikes/ai-masks/upscale-bench.mjs <models dir> [threads]
// <models dir> holds realesr-general-x4v3.onnx, model_x2.onnx and model_x4.onnx (RealPLKSR).
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const [dir, threads] = [process.argv[2], Number(process.argv[3] ?? 1)];
const require = createRequire(import.meta.url);
const ort = require('onnxruntime-web');
ort.env.wasm.numThreads = threads;
const models = [
  // name, file, input side, scale
  ['real-esrgan x4v3', 'realesr-general-x4v3.onnx', 128, 4],
  ['realplksr x2', 'model_x2.onnx', 512, 2],
  ['realplksr x4', 'model_x4.onnx', 256, 4],
];
const MP24 = 24e6;
for (const [name, file, side, scale] of models) {
  try {
    const t0 = performance.now();
    const s = await ort.InferenceSession.create(readFileSync(`${dir}/${file}`), { executionProviders: ['wasm'], enableCpuMemArena: false });
    const t1 = performance.now();
    const shape = [1, 3, side, side];
    const data = new Float32Array(3 * side * side);
    for (let i = 0; i < data.length; i++) data[i] = (i % 251) / 251;
    const feeds = { [s.inputNames[0]]: new ort.Tensor('float32', data, shape) };
    await s.run(feeds); // warm-up
    const t2 = performance.now();
    const out = await s.run(feeds);
    const t3 = performance.now();
    const o = out[s.outputNames[0]];
    const perMp = ((t3 - t2) / (side * side)) * 1e6;
    console.log(
      `${name}: in ${s.inputNames[0]} ${shape.join('x')} -> out ${s.outputNames[0]} ${o.dims.join('x')} (x${scale})`,
      `load ${((t1 - t0) / 1000).toFixed(1)}s, tile ${((t3 - t2) / 1000).toFixed(2)}s, ${(perMp / 1000).toFixed(1)} s/MP in,`,
      `24 MP: ${((perMp * MP24) / 1e6 / 60000).toFixed(0)} min, rss ${(process.memoryUsage().rss / 1e9).toFixed(2)} GB`,
    );
    await s.release();
  } catch (e) {
    console.log(name, 'FAILED', String(e).slice(0, 300));
  }
}
