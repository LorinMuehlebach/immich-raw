import sys, os, glob, rawpy, cv2, numpy as np
src, dst = sys.argv[1], sys.argv[2]
for p in sorted(glob.glob(os.path.join(src, '*'))):
    name = os.path.splitext(os.path.basename(p))[0]
    with rawpy.imread(p) as r:
        rgb = r.postprocess(half_size=True, use_camera_wb=True, output_bps=8, no_auto_bright=False)
    h, w = rgb.shape[:2]
    s = 2048 / max(h, w)
    if s < 1: rgb = cv2.resize(rgb, (round(w*s), round(h*s)), interpolation=cv2.INTER_AREA)
    cv2.imwrite(os.path.join(dst, name + '.jpg'), cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 92])
    print(name, rgb.shape)
