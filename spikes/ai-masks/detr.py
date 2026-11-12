import sys, os, glob, time, cv2, numpy as np, onnxruntime as ort
S = sys.argv[1]; M = S + '/models'; OUT = S + '/out'; SHORT = int(sys.argv[2]) if len(sys.argv) > 2 else 800
ort.set_default_logger_severity(3)
o = ort.SessionOptions(); o.intra_op_num_threads = 1
s = ort.InferenceSession(M + '/detr/model_quantized.onnx', o, providers=['CPUExecutionProvider'])
CATS = {
 'sky': [187], 'water': [148, 155, 178], 'vegetation': [184, 193, 119],
 'mountains': [192], 'architecture': [197, 128, 95, 151, 171, 175, 176, 177, 199, 185, 166],
 'naturalGround': [194, 154, 125, 198], 'artificialGround': [149, 191, 147, 144, 161, 190, 118, 145],
 'snow': [159], 'person': [1],
}
COL = {'sky': (90,160,255), 'water': (0,60,200), 'vegetation': (40,200,40), 'mountains': (150,100,60), 'architecture': (230,60,60),
       'naturalGround': (200,170,90), 'artificialGround': (140,140,140), 'snow': (255,255,255), 'person': (255,0,255)}
mean = np.array([0.485,0.456,0.406],np.float32); std = np.array([0.229,0.224,0.225],np.float32)
rows = []
for p in sorted(glob.glob(S + '/imgs/*.jpg')):
    im = cv2.cvtColor(cv2.imread(p), cv2.COLOR_BGR2RGB); h, w = im.shape[:2]
    sc = SHORT / min(h, w); nh, nw = round(h*sc), round(w*sc)
    x = (cv2.resize(im, (nw, nh), interpolation=cv2.INTER_LINEAR).astype(np.float32)/255 - mean)/std
    x = x.transpose(2,0,1)[None]
    t = time.time()
    logits, boxes, masks = s.run(None, {'pixel_values': x, 'pixel_mask': np.ones((1, 64, 64), np.int64)})
    dt = time.time() - t
    e = np.exp(logits[0] - logits[0].max(-1, keepdims=True)); pr = e / e.sum(-1, keepdims=True)
    lab = pr[:, :-1].argmax(-1); sc_ = pr[np.arange(len(lab)), lab]
    noobj = pr[:, -1]
    keep = (sc_ > 0.7) & (sc_ > noobj)
    mk = 1/(1+np.exp(-masks[0][keep])); mk = np.stack([cv2.resize(m, (w, h), interpolation=cv2.INTER_LINEAR) for m in mk]) if keep.any() else np.zeros((0,h,w))
    owner = (mk * sc_[keep][:, None, None]).argmax(0) if keep.any() else None
    kl = lab[keep]
    over = im.astype(np.float32).copy()
    found = []
    for name, ids in CATS.items():
        sel = np.isin(kl, ids)
        if not sel.any(): continue
        reg = np.isin(owner, np.where(sel)[0]) & (mk.max(0) > 0.5)
        if reg.mean() < 0.002: continue
        found.append(f'{name}:{reg.mean():.2f}')
        over[reg] = over[reg]*0.4 + np.array(COL[name])*0.6
    print(os.path.basename(p), f'{dt:.2f}s', masks.shape, keep.sum(), 'queries', found, flush=True)
    rows.append(cv2.resize(over.astype(np.uint8), (768, 512)))
cv2.imwrite(OUT + f'/scene{SHORT}.jpg', cv2.cvtColor(np.vstack([np.hstack(rows[:2]), np.hstack(rows[2:4]), np.hstack([rows[4], np.zeros_like(rows[4])])]), cv2.COLOR_RGB2BGR))
