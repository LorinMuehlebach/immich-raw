# AI masks spike

How the AI mask models were chosen; results in [docs/spike-results.md](../../docs/spike-results.md#ai-masks-model-choice-2026-11-11).
Quality runs in Python with onnxruntime and MediaPipe (the culler's environment has both), WASM
speed in Node with onnxruntime-web.

All scripts take a work folder `W` with `imgs/` (test images), `models/` and `out/` (results).

1. Test images, 2048 px, from the sample RAWs (`node spikes/decode-bench/fetch-samples.mjs samples`):

   ```sh
   services/culler/.venv/Scripts/python -I spikes/ai-masks/prep.py samples W/imgs
   ```

2. Models, into `W/models/<name>/` (URLs and revisions as in `packages/ai/src/models.ts`):
   `isnet/model_quantized.onnx`, `ormbg/model_quantized.onnx`, `birefnet/model_fp16.onnx`,
   `detr/model_quantized.onnx` (Xenova/detr-resnet-50-panoptic), `upernet/model.onnx`,
   `sam/vision_encoder_quantized.onnx`, `sam/prompt_encoder_mask_decoder_quantized.onnx`,
   `mp/selfie_multiclass_256x256.tflite`, `mp/face_landmarker.task`.

3. Runs (each writes a contact sheet to `W/out/`):

   | Script | What |
   |---|---|
   | `subject.py W subject` | IS-Net, ormbg (and BiRefNet_lite) on every image |
   | `detr.py W 800` | DETR panoptic, Lightroom's landscape categories |
   | `scene.py W 512` | UperNet ADE20K, Lightroom's landscape categories |
   | `people.py W <image> …` | people (images in `W/people/`): tiles of the multiclass segmenter, face landmarks |
   | `objects.py W` | SlimSAM with clicks and with a box turned into points |
   | `object-box.py W` | IS-Net inside a box |
   | `node wasm-bench.mjs W <threads>` | onnxruntime-web WASM speed and memory |
