# HyperHDR "leds" layout for the Govee H605C, built from measured corner positions in LED units.
# The strip (216 LEDs, 15 equal segments of 14.4 LEDs) starts at the bottom-right corner, runs up the
# right side, right-to-left along the top, down the left side, left-to-right along the bottom.
# usage: python3 layout.py [segments] [total_leds] [corner1,corner2,corner3]
#   cornerN = LED index (from strip start) where the strip turns: right->top, top->left, left->bottom.
import json, sys
N = int(sys.argv[1]) if len(sys.argv) > 1 else 15
LEDS = float(sys.argv[2]) if len(sys.argv) > 2 else 216.0
C = [float(x) for x in sys.argv[3].split(',')] if len(sys.argv) > 3 else [43.2, 104.2, 147.4]
depth = 0.10
sides = [(0, C[0]), (C[0], C[1]), (C[1], C[2]), (C[2], LEDS)]
def point(t):   # LED position -> (x, y) picture coords, (0,0) top-left
    a, b = sides[0]
    if t < b: return (1.0, 1.0 - (t - a) / (b - a))               # right side, bottom -> top
    a, b = sides[1]
    if t < b: return (1.0 - (t - a) / (b - a), 0.0)               # top, right -> left
    a, b = sides[2]
    if t < b: return (0.0, (t - a) / (b - a))                     # left side, top -> bottom
    a, b = sides[3]
    return (min((t - a) / (b - a), 1.0), 1.0)                     # bottom, left -> right
seg = LEDS / N
leds = []
for i in range(N):
    t0, t1 = seg * i, seg * (i + 1)
    pts = [point(t0 + (t1 - t0) * k / 8.0) for k in range(9)]
    xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
    hmin, hmax, vmin, vmax = min(xs), max(xs), min(ys), max(ys)
    if vmax - vmin < depth:
        if vmin < 0.5: vmax = vmin + depth
        else: vmin = vmax - depth
    if hmax - hmin < depth:
        if hmin < 0.5: hmax = hmin + depth
        else: hmin = hmax - depth
    leds.append({"hmin": round(hmin, 4), "hmax": round(hmax, 4), "vmin": round(vmin, 4), "vmax": round(vmax, 4), "group": 0})
sys.stderr.write("sides in LEDs: right %.1f, top %.1f, left %.1f, bottom %.1f; segment %.1f LEDs\n" % (C[0], C[1]-C[0], C[2]-C[1], LEDS-C[2], seg))
print(json.dumps(leds))
