import sys, time, cv2, numpy as np, onnxruntime as ort
S = sys.argv[1]; M = S + '/models/sam'; OUT = S + '/out'
ort.set_default_logger_severity(3)
o = ort.SessionOptions(); o.intra_op_num_threads = 1; o.enable_cpu_mem_arena = False
enc = ort.InferenceSession(M + '/vision_encoder_quantized.onnx', o, providers=['CPUExecutionProvider'])
dec = ort.InferenceSession(M + '/prompt_encoder_mask_decoder_quantized.onnx', o, providers=['CPUExecutionProvider'])
mean = np.array([0.485,0.456,0.406],np.float32); std = np.array([0.229,0.224,0.225],np.float32)
# (image, positive points as fractions, box as fractions or None)
cases = [('imgs/canon-r5.jpg', [(0.55, 0.42)], None), ('imgs/leica-q2.jpg', [], (0.28, 0.40, 0.75, 0.62)), ('imgs2/group.jpg', [(0.565, 0.18), (0.535, 0.32)], None)]
tiles = []
for path, pts, box in cases:
    im = cv2.cvtColor(cv2.imread(S + '/' + path), cv2.COLOR_BGR2RGB)
    s0 = 2048 / max(im.shape[:2]); im = cv2.resize(im, (round(im.shape[1]*s0), round(im.shape[0]*s0)), interpolation=cv2.INTER_AREA)
    h, w = im.shape[:2]; sc = 1024 / max(h, w); nh, nw = round(h*sc), round(w*sc)
    x = np.zeros((1024, 1024, 3), np.float32); x[:nh, :nw] = (cv2.resize(im, (nw, nh), interpolation=cv2.INTER_LINEAR).astype(np.float32)/255 - mean)/std
    t = time.time(); emb, pos = enc.run(None, {'pixel_values': x.transpose(2,0,1)[None]}); te = time.time() - t
    P = [(px*w, py*h) for px, py in pts]
    if box:
        bx0, by0, bx1, by1 = box[0]*w, box[1]*h, box[2]*w, box[3]*h
        cx, cy = (bx0+bx1)/2, (by0+by1)/2; dx, dy = (bx1-bx0)/4, (by1-by0)/4
        P += [(cx, cy), (cx-dx, cy), (cx+dx, cy), (cx, cy-dy), (cx, cy+dy)]
    pts_in = np.array([[[[px*sc, py*sc] for px, py in P]]], np.float32)
    lab = np.ones((1, 1, len(P)), np.int64)
    t = time.time(); iou, masks = dec.run(None, {'input_points': pts_in, 'input_labels': lab, 'image_embeddings': emb, 'image_positional_embeddings': pos}); td = time.time() - t
    ms = masks[0, 0]  # 3 x 256 x 256 over the padded 1024 square
    best, bs = None, -1
    for k in range(3):
        m = cv2.resize(ms[k], (1024, 1024))[:nh, :nw]; m = cv2.resize(m, (w, h)) > 0
        score = float(iou[0, 0, k])
        if box:
            inside = m[int(by0):int(by1), int(bx0):int(bx1)].sum() / max(1, m.sum())
            cover = m[int(by0):int(by1), int(bx0):int(bx1)].mean()
            score *= inside * np.sqrt(cover)
        if score > bs: best, bs = m, score
    print(path, f'encoder {te:.2f}s decoder {td:.3f}s', np.round(iou[0,0], 3), flush=True)
    o2 = im.astype(np.float32); o2[best] = o2[best]*0.4 + np.array([255,40,60])*0.6
    for px, py in P: cv2.circle(o2, (int(px), int(py)), 12, (255,255,0), -1)
    if box: cv2.rectangle(o2, (int(bx0), int(by0)), (int(bx1), int(by1)), (255,255,0), 4)
    tiles.append(cv2.resize(o2.clip(0,255).astype(np.uint8), (768, 512)))
cv2.imwrite(OUT + '/sam.jpg', cv2.cvtColor(np.vstack([np.hstack(tiles[:2]), np.hstack([tiles[2], np.zeros_like(tiles[2])])]), cv2.COLOR_RGB2BGR))
