import sys, os, time, cv2, numpy as np, onnxruntime as ort, mediapipe as mp
from mediapipe.tasks.python import vision, BaseOptions
S = sys.argv[1]; M = S + '/models'; OUT = S + '/out'
ort.set_default_logger_severity(3)
o = ort.SessionOptions(); o.intra_op_num_threads = 1
up = ort.InferenceSession(M + '/upernet/model.onnx', o, providers=['CPUExecutionProvider'])
seg = vision.ImageSegmenter.create_from_options(vision.ImageSegmenterOptions(base_options=BaseOptions(model_asset_path=M + '/mp/selfie_multiclass_256x256.tflite'), output_confidence_masks=True, output_category_mask=False))
fl = vision.FaceLandmarker.create_from_options(vision.FaceLandmarkerOptions(base_options=BaseOptions(model_asset_path=M + '/mp/face_landmarker.task'), num_faces=10, min_face_detection_confidence=0.3))
mean = np.array([0.485,0.456,0.406],np.float32); std = np.array([0.229,0.224,0.225],np.float32)
LIPS_O=[61,146,91,181,84,17,314,405,321,375,291,409,270,269,267,0,37,39,40,185]
LIPS_I=[78,95,88,178,87,14,317,402,318,324,308,415,310,311,312,13,82,81,80,191]
EYE_L=[263,249,390,373,374,380,381,382,362,398,384,385,386,387,388,466]; EYE_R=[33,7,163,144,145,153,154,155,133,173,157,158,159,160,161,246]
BROW_L=[300,293,334,296,336,285,295,282,283,276]; BROW_R=[70,63,105,66,107,55,65,52,53,46]
IRIS_L=[474,475,476,477]; IRIS_R=[469,470,471,472]
COL={'hair':(255,200,0),'bodySkin':(255,120,120),'faceSkin':(255,60,200),'clothes':(0,120,255),'lips':(255,0,0),'eyeSclera':(255,255,255),'iris':(0,255,0),'eyebrows':(120,60,0),'teeth':(0,255,255)}
for name in sys.argv[2:]:
    im = cv2.cvtColor(cv2.imread(S + '/people/' + name), cv2.COLOR_BGR2RGB)
    s = 2048 / max(im.shape[:2]); im = cv2.resize(im, (round(im.shape[1]*s), round(im.shape[0]*s)), interpolation=cv2.INTER_AREA)
    h, w = im.shape[:2]
    t=time.time()
    x = (cv2.resize(im, (512,512), interpolation=cv2.INTER_AREA).astype(np.float32)/255-mean)/std
    lg = up.run(None, {'pixel_values': x.transpose(2,0,1)[None]})[0][0]
    e=np.exp(lg-lg.max(0,keepdims=True)); pr=e/e.sum(0,keepdims=True)
    person = cv2.resize(pr[12], (w,h)) > 0.5
    t1=time.time()-t
    n, lab, stats, _ = cv2.connectedComponentsWithStats(person.astype(np.uint8))
    parts = {k: np.zeros((h,w), np.float32) for k in COL}
    t=time.time(); boxes=[]
    for i in range(1, n):
        x0,y0,bw,bh,area = stats[i]
        if area < 0.002*h*w: continue
        px, py = int(bw*0.1)+8, int(bh*0.1)+8
        x0,y0,x1,y1 = max(0,x0-px), max(0,y0-py), min(w,x0+bw+px), min(h,y0+bh+py)
        boxes.append((x0,y0,x1,y1))
        side = max(64, min(x1-x0, y1-y0, int(0.45*max(x1-x0, y1-y0))))
        def starts(a0, a1):
            if a1 - a0 <= side: return [a0]
            k = int(np.ceil((a1-a0-side)/(side/2))) + 1
            return [round(a0 + j*(a1-a0-side)/(k-1)) for j in range(k)]
        for ty in starts(y0, y1):
            for tx in starts(x0, x1):
                cx1, cy1 = min(w, tx+side), min(h, ty+side)
                crop = np.ascontiguousarray(im[ty:cy1, tx:cx1])
                r = seg.segment(mp.Image(image_format=mp.ImageFormat.SRGB, data=crop))
                cm = [m.numpy_view() for m in r.confidence_masks]
                for k, ci in (('hair',1),('bodySkin',2),('faceSkin',3),('clothes',4)):
                    parts[k][ty:cy1, tx:cx1] = np.maximum(parts[k][ty:cy1, tx:cx1], cv2.resize(cm[ci], (cx1-tx, cy1-ty)))
    # faces: components of face skin -> crop -> landmarker
    fn, flab, fst, _ = cv2.connectedComponentsWithStats((parts['faceSkin'] > 0.5).astype(np.uint8))
    face_lms = []
    for i in range(1, fn):
        fx, fy, fw, fh, fa = fst[i]
        if fa < 150: continue
        c = (fx + fw/2, fy + fh/2); r = max(fw, fh) * 1.0
        X0, Y0, X1, Y1 = int(max(0, c[0]-r)), int(max(0, c[1]-r)), int(min(w, c[0]+r)), int(min(h, c[1]+r))
        crop = np.ascontiguousarray(cv2.resize(im[Y0:Y1, X0:X1], (256, 256)))
        fr = fl.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=crop))
        for lm in fr.face_landmarks:
            face_lms.append([(X0 + p.x*(X1-X0), Y0 + p.y*(Y1-Y0)) for p in lm])
    t2=time.time()-t
    t=time.time()
    t3=time.time()-t
    def poly(lm, idx): return np.array([[lm[i][0], lm[i][1]] for i in idx], np.int32)
    for lm in face_lms:
        def fill(k, pts, sub=None):
            m = np.zeros((h,w), np.uint8); cv2.fillPoly(m, [pts], 1)
            if sub is not None: cv2.fillPoly(m, [sub], 0)
            parts[k] = np.maximum(parts[k], m.astype(np.float32))
        inner = poly(lm, LIPS_I)
        fill('lips', poly(lm, LIPS_O), inner)
        m = np.zeros((h,w), np.uint8); cv2.fillPoly(m, [inner], 1)
        lum = cv2.cvtColor(im, cv2.COLOR_RGB2HLS); bright = (lum[...,1] > np.percentile(lum[...,1][m>0], 50) if m.any() else lum[...,1]>200) & (lum[...,2] < 90)
        parts['teeth'] = np.maximum(parts['teeth'], (m.astype(bool) & bright).astype(np.float32))
        for E, I in ((EYE_L, IRIS_L), (EYE_R, IRIS_R)):
            ip = poly(lm, I); c = ip.mean(0); rad = np.linalg.norm(ip - c, axis=1).mean()
            em = np.zeros((h,w), np.uint8); cv2.fillPoly(em, [poly(lm, E)], 1)
            irm = np.zeros((h,w), np.uint8); cv2.circle(irm, tuple(int(v) for v in c), max(1,int(round(rad))), 1, -1)
            parts['iris'] = np.maximum(parts['iris'], (irm & em).astype(np.float32))
            parts['eyeSclera'] = np.maximum(parts['eyeSclera'], (em & (1-irm)).astype(np.float32))
        fill('eyebrows', poly(lm, BROW_L)); fill('eyebrows', poly(lm, BROW_R))
    print(name, f'upernet {t1:.2f}s, {len(boxes)} people, multiclass {t2:.2f}s, faces {len(face_lms)} {t3:.2f}s', flush=True)
    over = im.astype(np.float32)
    for k, m in parts.items():
        over = over*(1-0.6*m[...,None]) + np.array(COL[k],np.float32)*0.6*m[...,None]
    for b in boxes: cv2.rectangle(over, b[:2], b[2:], (255,255,0), 3)
    cv2.imwrite(OUT + '/people_' + name, cv2.cvtColor(cv2.resize(over.clip(0,255).astype(np.uint8), (w//2, h//2)), cv2.COLOR_RGB2BGR))
