import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const [dir, threads] = [process.argv[2], Number(process.argv[3] ?? 1)];
const require = createRequire(import.meta.url);
const ort = require('onnxruntime-web');
ort.env.wasm.numThreads = threads;
const models = [
  ['isnet', dir + '/models/isnet/model_quantized.onnx', 'input', [1, 3, 1024, 1024]],
  ['upernet', dir + '/models/upernet/model.onnx', 'pixel_values', [1, 3, 512, 512]],
  ['sam-enc', dir + '/models/sam/vision_encoder_quantized.onnx', 'pixel_values', [1, 3, 1024, 1024]],
];
for (const [name, path, input, shape] of models) {
  try {
    const t0 = performance.now();
    const s = await ort.InferenceSession.create(readFileSync(path), { executionProviders: ['wasm'] });
    const t1 = performance.now();
    const data = new Float32Array(shape.reduce((a, b) => a * b)).fill(0.1);
    await s.run({ [input]: new ort.Tensor('float32', data, shape) });
    const t2 = performance.now();
    console.log(name, `load ${((t1 - t0) / 1000).toFixed(1)}s run ${((t2 - t1) / 1000).toFixed(1)}s`, `rss ${(process.memoryUsage().rss / 1e9).toFixed(2)} GB`);
    await s.release();
  } catch (e) { console.log(name, 'FAILED', String(e).slice(0, 300)); }
}
