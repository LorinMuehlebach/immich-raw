import sys, os, glob, time, cv2, numpy as np, onnxruntime as ort
S = sys.argv[1]; M = S + '/models'; OUT = S + '/out'
ort.set_default_logger_severity(3)
def sess(p, threads=1):
    o = ort.SessionOptions(); o.intra_op_num_threads = threads; o.inter_op_num_threads = 1
    return ort.InferenceSession(p, o, providers=['CPUExecutionProvider'])
imgs = {os.path.splitext(os.path.basename(p))[0]: cv2.cvtColor(cv2.imread(p), cv2.COLOR_BGR2RGB) for p in sorted(glob.glob(S + '/imgs/*.jpg'))}

def subject(name, path, mean, std, inp):
    s = sess(path)
    res = {}
    for k, im in imgs.items():
        x = cv2.resize(im, (1024, 1024), interpolation=cv2.INTER_LINEAR).astype(np.float32)
        x = (x - mean) / std
        x = x.transpose(2, 0, 1)[None]
        t = time.time(); y = s.run(None, {inp: x})[0]; dt = time.time() - t
        m = y[0, 0]
        if m.max() > 1.5 or m.min() < -0.5: m = 1 / (1 + np.exp(-m))
        m = (m - m.min()) / max(1e-6, m.max() - m.min()) if name == 'isnet' else m
        res[k] = cv2.resize(m, (im.shape[1], im.shape[0]))
        print(name, k, f'{dt:.2f}s', flush=True)
    return res

def overlay(im, m, color=(255, 40, 60)):
    o = im.astype(np.float32); c = np.array(color, np.float32)
    o = o * (1 - 0.55 * m[..., None]) + c * 0.55 * m[..., None]
    return o.clip(0, 255).astype(np.uint8)

which = sys.argv[2].split(',')
rows = []
if 'subject' in which:
    outs = {
        'isnet': subject('isnet', M + '/isnet/model_quantized.onnx', np.array([128,128,128],np.float32), np.array([256,256,256],np.float32), 'input'),
        'ormbg': subject('ormbg', M + '/ormbg/model_quantized.onnx', np.array([0,0,0],np.float32), np.array([255,255,255],np.float32), 'pixel_values'),
    }
    for k, im in imgs.items():
        tiles = [cv2.resize(overlay(im, outs[n][k]), (512, 342)) for n in outs]
        rows.append(np.hstack(tiles))
    cv2.imwrite(OUT + '/subject.jpg', cv2.cvtColor(np.vstack(rows), cv2.COLOR_RGB2BGR))
