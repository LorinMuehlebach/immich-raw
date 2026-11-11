import sys, cv2, numpy as np, onnxruntime as ort, time
S = sys.argv[1]
ort.set_default_logger_severity(3)
o = ort.SessionOptions(); o.intra_op_num_threads = 1
s = ort.InferenceSession(S + '/models/isnet/model_quantized.onnx', o, providers=['CPUExecutionProvider'])
cases = [('imgs/leica-q2.jpg', (0.33, 0.40, 0.76, 0.68)), ('imgs2/group.jpg', (0.40, 0.48, 0.66, 0.90)), ('imgs/fuji-xt5.jpg', (0.60, 0.20, 1.0, 0.75))]
tiles = []
for path, b in cases:
    im = cv2.cvtColor(cv2.imread(S + '/' + path), cv2.COLOR_BGR2RGB)
    k = 2048 / max(im.shape[:2]); im = cv2.resize(im, (round(im.shape[1]*k), round(im.shape[0]*k)), interpolation=cv2.INTER_AREA)
    h, w = im.shape[:2]
    x0, y0, x1, y1 = int(b[0]*w), int(b[1]*h), int(b[2]*w), int(b[3]*h)
    mx, my = int((x1-x0)*0.1), int((y1-y0)*0.1)
    X0, Y0, X1, Y1 = max(0, x0-mx), max(0, y0-my), min(w, x1+mx), min(h, y1+my)
    crop = im[Y0:Y1, X0:X1]
    side = 1024
    x = (cv2.resize(crop, (side, side)).astype(np.float32) - 128) / 256
    t = time.time(); m = s.run(None, {'input': x.transpose(2,0,1)[None]})[0][0, 0]; dt = time.time() - t
    m = (m - m.min()) / max(1e-6, m.max() - m.min())
    full = np.zeros((h, w), np.float32); full[Y0:Y1, X0:X1] = cv2.resize(m, (X1-X0, Y1-Y0))
    print(path, f'{dt:.2f}s')
    ov = im.astype(np.float32); ov = ov*(1-0.6*full[..., None]) + np.array([255, 40, 60])*0.6*full[..., None]
    cv2.rectangle(ov, (x0, y0), (x1, y1), (255, 255, 0), 4)
    tiles.append(cv2.resize(ov.clip(0, 255).astype(np.uint8), (768, 512)))
cv2.imwrite(S + '/out/boxsal.jpg', cv2.cvtColor(np.vstack([np.hstack(tiles[:2]), np.hstack([tiles[2], np.zeros_like(tiles[2])])]), cv2.COLOR_RGB2BGR))
