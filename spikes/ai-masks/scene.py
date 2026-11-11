import sys, os, glob, time, cv2, numpy as np, onnxruntime as ort
S = sys.argv[1]; M = S + '/models'; OUT = S + '/out'; SIZE = int(sys.argv[2])
ort.set_default_logger_severity(3)
o = ort.SessionOptions(); o.intra_op_num_threads = 1
s = ort.InferenceSession(M + '/upernet/model.onnx', o, providers=['CPUExecutionProvider'])
print([(i.name, i.shape) for i in s.get_inputs()], [(i.name, i.shape) for i in s.get_outputs()])
CATS = {'sky': [2], 'water': [21, 26, 60, 128, 113, 109, 104], 'vegetation': [4, 9, 17, 66, 72, 29],
 'mountains': [16, 68], 'architecture': [1, 25, 48, 79, 84, 61, 0, 32, 42, 38, 86, 106, 114, 8, 14, 51],
 'naturalGround': [13, 46, 94, 91, 34], 'artificialGround': [6, 11, 3, 52, 53, 54, 59, 121], 'person': [12]}
COL = {'sky': (90,160,255), 'water': (0,60,200), 'vegetation': (40,200,40), 'mountains': (150,100,60), 'architecture': (230,60,60),
       'naturalGround': (200,170,90), 'artificialGround': (140,140,140), 'person': (255,0,255)}
mean = np.array([0.485,0.456,0.406],np.float32); std = np.array([0.229,0.224,0.225],np.float32)
rows = []
for p in sorted(glob.glob(S + '/imgs/*.jpg')):
    im = cv2.cvtColor(cv2.imread(p), cv2.COLOR_BGR2RGB); h, w = im.shape[:2]
    x = (cv2.resize(im, (SIZE, SIZE), interpolation=cv2.INTER_AREA).astype(np.float32)/255 - mean)/std
    t = time.time()
    try:
        lg = s.run(None, {'pixel_values': x.transpose(2,0,1)[None]})[0][0]
    except Exception as e:
        print('fail', e); break
    dt = time.time() - t
    e = np.exp(lg - lg.max(0, keepdims=True)); pr = e / e.sum(0, keepdims=True)
    over = im.astype(np.float32).copy(); found = []
    for name, ids in CATS.items():
        prob = cv2.resize(pr[ids].sum(0), (w, h), interpolation=cv2.INTER_LINEAR)
        if prob.mean() < 0.003: continue
        found.append(f'{name}:{prob.mean():.2f}')
        over = over * (1 - 0.6*prob[..., None]) + np.array(COL[name], np.float32) * 0.6 * prob[..., None]
    print(os.path.basename(p), f'{dt:.2f}s', lg.shape, found, flush=True)
    rows.append(cv2.resize(over.clip(0,255).astype(np.uint8), (768, 512)))
cv2.imwrite(OUT + f'/ade{SIZE}.jpg', cv2.cvtColor(np.vstack([np.hstack(rows[:2]), np.hstack(rows[2:4]), np.hstack([rows[4], np.zeros_like(rows[4])])]), cv2.COLOR_RGB2BGR))
