"""Eye-communication web server (Flask).

Runs on the same machine as the tracker (laptop now, Raspberry Pi later).

    tracker  --POST /api/gaze-->  server  --SSE /api/stream-->  browser UI

The browser UI also works with no tracker at all (mouse mode), so the UI can be
developed and demoed without the glasses.

Run:
    python app/server.py                       # mouse mode only
    python app/server.py --gaze-file PATH      # also bridge the tracker's gaze_vector.txt
Then open http://localhost:5000 and press C to calibrate (needs gaze mode).
"""
import argparse
import json
import math
import queue
import threading
import time
from pathlib import Path

import numpy as np
from flask import Flask, Response, jsonify, request, send_from_directory

APP_DIR = Path(__file__).resolve().parent
STATIC_DIR = APP_DIR / "static"
VOCAB_PATH = APP_DIR / "vocab.json"

# Settings that main() can override from the command line.
CFG = {
    "calib_path": APP_DIR / "calibration.json",
    "screen_w_cm": None,  # optional: lets accuracy be reported in degrees
    "distance_cm": None,  # optional: eye-to-screen distance
}

app = Flask(__name__, static_folder=str(STATIC_DIR), static_url_path="/static")

# --------------------------------------------------------------------------
# Gaze broadcast (latest-value-wins, so a slow browser never builds a backlog)
# --------------------------------------------------------------------------
_subscribers = []
_sub_lock = threading.Lock()
_latest = {"gaze": None, "time": 0.0}


def publish_gaze(sample):
    """sample: dict with x, y in 0..1 (screen-normalised) and/or raw = [yaw, pitch].

    If a calibration exists and the sample has raw angles, x and y are replaced by
    the calibrated screen position."""
    sample = _apply_calibration(dict(sample))
    sample["t"] = time.time()
    _latest["gaze"] = sample
    _latest["time"] = sample["t"]
    with _sub_lock:
        for q in _subscribers:
            try:
                q.get_nowait()  # drop the stale sample, keep only the newest
            except queue.Empty:
                pass
            q.put_nowait(sample)


def _clamp01(v):
    v = float(v)
    if not math.isfinite(v):
        raise ValueError("not finite")
    return max(0.0, min(1.0, v))


@app.post("/api/gaze")
def api_gaze():
    """Tracker pushes a sample. Either screen position, or raw gaze angles (radians):

        {"x": 0..1, "y": 0..1}            already a screen position
        {"raw": [yaw, pitch]}             mapped to the screen if a calibration exists
        "confidence": 0..1 is optional in both cases.
    """
    data = request.get_json(silent=True) or {}
    sample = {}
    try:
        if "raw" in data:
            sample["raw"] = [float(data["raw"][0]), float(data["raw"][1])]
        if "vec" in data:  # optional: the 3D gaze vector, only used for display
            sample["vec"] = [float(data["vec"][0]), float(data["vec"][1]), float(data["vec"][2])]
        if "x" in data and "y" in data:
            sample["x"], sample["y"] = _clamp01(data["x"]), _clamp01(data["y"])
        if not all(math.isfinite(v) for v in
                   sample.get("raw", []) + sample.get("vec", []) + [sample.get("x", 0), sample.get("y", 0)]):
            raise ValueError("not finite")
    except (KeyError, IndexError, TypeError, ValueError):
        sample = {}
    if not sample:
        return jsonify(error="body must be JSON with numeric x and y in 0..1, or raw: [yaw, pitch]"), 400
    if "confidence" in data:
        try:
            sample["confidence"] = _clamp01(data["confidence"])
        except (TypeError, ValueError):
            pass
    publish_gaze(sample)
    return jsonify(ok=True)


@app.get("/api/stream")
def api_stream():
    """Server-Sent Events stream of gaze samples for the browser."""
    q = queue.Queue(maxsize=1)
    with _sub_lock:
        _subscribers.append(q)

    def gen():
        try:
            yield "retry: 1000\n\n"
            while True:
                try:
                    sample = q.get(timeout=15)
                    yield f"data: {json.dumps(sample)}\n\n"
                except queue.Empty:
                    yield ": keepalive\n\n"
        finally:
            with _sub_lock:
                if q in _subscribers:
                    _subscribers.remove(q)

    return Response(
        gen(),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/api/status")
def api_status():
    age = time.time() - _latest["time"] if _latest["time"] else None
    return jsonify(
        gaze_live=age is not None and age < 1.0,
        last_sample_age_s=age,
        clients=len(_subscribers),
        calibrated=_calib is not None,
    )


# --------------------------------------------------------------------------
# Calibration: raw gaze angles (yaw, pitch) -> screen position
# --------------------------------------------------------------------------
# The browser shows 9 dots and sends the raw gaze angle measured at each one. We fit
# a mapping raw -> screen position by least squares and apply it to every later sample.
#
# Two models are tried: "affine" (a flat mapping) and "quadratic" (allows some curve).
# The one with the smaller leave-one-out error is kept. Leave-one-out = drop one dot,
# fit on the other eight, and measure how far off the prediction for the dropped dot is.
# That is an honest accuracy estimate (it is pessimistic for the corner dots, which
# become extrapolations). The error on the dots used for the fit would look too good.
_calib = None  # {"fit": {...}, "meta": {...}} or None


def _feat(model, z):
    u, v = z[:, 0], z[:, 1]
    cols = [np.ones(len(z)), u, v]
    if model == "quadratic":
        cols += [u * u, u * v, v * v]
    return np.stack(cols, axis=1)


def _fit(model, raw, target, lam=1e-3):
    mean = raw.mean(axis=0)
    std = raw.std(axis=0)
    std = np.where(std < 1e-9, 1.0, std)
    X = _feat(model, (raw - mean) / std)
    reg = lam * np.eye(X.shape[1])
    reg[0, 0] = 0.0  # never shrink the offset term
    w = np.linalg.solve(X.T @ X + reg, X.T @ target)
    return {"model": model, "mean": mean.tolist(), "std": std.tolist(), "w": w.tolist()}


def _predict(fit, raw):
    raw = np.atleast_2d(np.asarray(raw, dtype=float))
    z = (raw - np.array(fit["mean"])) / np.array(fit["std"])
    return _feat(fit["model"], z) @ np.array(fit["w"])


def _err_pct(pred, target, w_px, h_px):
    """Distance between prediction and target, in % of the screen width."""
    d = (pred - target) * np.array([w_px, h_px])
    return np.hypot(d[:, 0], d[:, 1]) / w_px * 100.0


def _to_deg(pct_of_width):
    if not (CFG["screen_w_cm"] and CFG["distance_cm"]):
        return None
    cm = pct_of_width / 100.0 * CFG["screen_w_cm"]
    return math.degrees(math.atan(cm / CFG["distance_cm"]))


def fit_calibration(points, w_px, h_px):
    raw = np.array([p["raw"] for p in points], dtype=float)
    tgt = np.array([p["target"] for p in points], dtype=float)
    n = len(points)
    if np.any(raw.std(axis=0) < 1e-4):
        raise ValueError("The gaze values barely changed between the dots. "
                         "Is the tracker running and following your eye?")

    def loo(model):
        errs = np.empty(n)
        for i in range(n):
            keep = np.arange(n) != i
            m = _fit(model, raw[keep], tgt[keep])
            errs[i] = _err_pct(_predict(m, raw[i]), tgt[i:i + 1], w_px, h_px)[0]
        return errs

    loo_errs = {"affine": loo("affine")}
    if n >= 7:  # a quadratic has 6 numbers per axis, so leave-one-out needs more than 6 points
        loo_errs["quadratic"] = loo("quadratic")
    best = "affine"
    if "quadratic" in loo_errs and loo_errs["quadratic"].mean() < 0.9 * loo_errs["affine"].mean():
        best = "quadratic"  # only worth the extra flexibility if it is clearly better

    fit = _fit(best, raw, tgt)
    train = _err_pct(_predict(fit, raw), tgt, w_px, h_px)
    loo_mean = float(loo_errs[best].mean())
    meta = {
        "model": best,
        "n_points": n,
        "loo_mean_pct": loo_mean,
        "loo_max_pct": float(loo_errs[best].max()),
        "loo_mean_deg": _to_deg(loo_mean),
        "train_mean_pct": float(train.mean()),
        "loo_mean_pct_by_model": {k: float(v.mean()) for k, v in loo_errs.items()},
        "per_point_loo_pct": [float(v) for v in loo_errs[best]],
        "screen_px": [w_px, h_px],
        "created": time.strftime("%Y-%m-%d %H:%M:%S"),
    }
    return {"fit": fit, "meta": meta}


def _apply_calibration(sample):
    c = _calib
    raw = sample.get("raw")
    if c is not None and raw is not None:
        x, y = _predict(c["fit"], raw)[0]
        sample["x"], sample["y"] = _clamp01(x), _clamp01(y)
        sample["calibrated"] = True
    else:
        sample["calibrated"] = False
    return sample


def _calib_public():
    c = _calib
    return {"calibrated": False} if c is None else {"calibrated": True, **c["meta"]}


def load_calibration():
    global _calib
    try:
        c = json.loads(Path(CFG["calib_path"]).read_text())
        _predict(c["fit"], [0.0, 0.0])  # make sure the saved file is usable
        _ = c["meta"]["loo_mean_pct"]
        _calib = c
        print(f"[calibration] loaded ({c['meta']['model']}, ~{c['meta']['loo_mean_pct']:.1f}% error)")
    except (OSError, ValueError, KeyError, TypeError, IndexError):
        _calib = None


@app.get("/api/calibration")
def api_calibration_get():
    return jsonify(_calib_public())


@app.post("/api/calibration")
def api_calibration_post():
    """Body: {"points": [{"target": [x, y], "raw": [yaw, pitch]}, ...], "screen": {"w": px, "h": px}}"""
    global _calib
    data = request.get_json(silent=True) or {}
    try:
        pts = []
        for p in data["points"]:
            t = [float(p["target"][0]), float(p["target"][1])]
            r = [float(p["raw"][0]), float(p["raw"][1])]
            if not all(math.isfinite(v) for v in t + r):
                raise ValueError("not finite")
            pts.append({"target": t, "raw": r})
        scr = data.get("screen") or {}
        w_px, h_px = float(scr.get("w", 1920)), float(scr.get("h", 1080))
        if w_px <= 0 or h_px <= 0:
            raise ValueError("bad screen size")
    except (KeyError, IndexError, TypeError, ValueError):
        return jsonify(error="bad calibration data"), 400
    if len(pts) < 4:
        return jsonify(error="need at least 4 calibration points"), 400
    try:
        result = fit_calibration(pts, w_px, h_px)
    except (ValueError, np.linalg.LinAlgError) as e:
        return jsonify(error=str(e)), 422
    _calib = result
    try:
        Path(CFG["calib_path"]).write_text(json.dumps(result, indent=2))
    except OSError as e:
        print("[calibration] could not save:", e)
    return jsonify(_calib_public())


@app.delete("/api/calibration")
def api_calibration_delete():
    global _calib
    _calib = None
    try:
        Path(CFG["calib_path"]).unlink()
    except OSError:
        pass
    return jsonify(_calib_public())


# --------------------------------------------------------------------------
# Vocabulary + pages
# --------------------------------------------------------------------------
@app.get("/api/vocab")
def api_vocab():
    with open(VOCAB_PATH, encoding="utf-8") as f:
        return jsonify(json.load(f))


@app.get("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


# --------------------------------------------------------------------------
# Temporary bridge: read the tracker's gaze_vector.txt
# --------------------------------------------------------------------------
# Orlosky3DEyeTracker.py overwrites gaze_vector.txt every frame with one line:
#   sphere_cx, sphere_cy, sphere_cz, gaze_x, gaze_y, gaze_z
# The gaze direction is turned into two angles (yaw, pitch) and published as "raw".
# Before calibration, x/y come from a fixed gain (a rough demo only). After calibration,
# publish_gaze() replaces x/y using the fitted mapping, so --gain, --flip-x and
# --flip-y no longer matter.
def bridge_gaze_file(path, gain=1.5, smoothing=0.35, flip_x=False, flip_y=False):
    path = Path(path)
    sx = sy = None
    syaw = spitch = None
    last_sig = None  # (modified time, file text) of the last line we published
    print(f"[bridge] reading {path} (gain={gain})")
    while True:
        time.sleep(1 / 60)
        try:
            mtime = path.stat().st_mtime_ns
            text = path.read_text().strip()
            vals = [float(v) for v in text.split(",")]
        except (OSError, ValueError):
            continue  # file missing or caught mid-write; try again
        if len(vals) != 6:
            continue
        # The tracker rewrites this file every frame. If neither the modified time
        # nor the text changed, the tracker has stopped (blink, lost pupil, closed),
        # so publish nothing and let the page show "no signal".
        sig = (mtime, text)
        if sig == last_sig:
            continue
        last_sig = sig
        gx, gy, gz = vals[3], vals[4], vals[5]
        x = 0.5 + (-gx if flip_x else gx) * gain
        y = 0.5 + (gy if flip_y else -gy) * gain
        x, y = _clamp01(x), _clamp01(y)
        sx = x if sx is None else sx + smoothing * (x - sx)
        sy = y if sy is None else sy + smoothing * (y - sy)
        yaw, pitch = math.atan2(gx, gz), math.atan2(gy, gz)  # radians
        syaw = yaw if syaw is None else syaw + smoothing * (yaw - syaw)
        spitch = pitch if spitch is None else spitch + smoothing * (pitch - spitch)
        publish_gaze({"x": sx, "y": sy, "raw": [syaw, spitch], "vec": [gx, gy, gz],
                      "source": "gaze_vector.txt"})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1",
                    help="use 0.0.0.0 to let another device (e.g. a TV) reach it")
    ap.add_argument("--port", type=int, default=5000)
    ap.add_argument("--gaze-file", help="path to the tracker's gaze_vector.txt")
    ap.add_argument("--gain", type=float, default=1.5)
    ap.add_argument("--flip-x", action="store_true")
    ap.add_argument("--flip-y", action="store_true")
    ap.add_argument("--calibration-file", default=str(CFG["calib_path"]),
                    help="where the calibration is saved (default: app/calibration.json)")
    ap.add_argument("--screen-width-cm", type=float,
                    help="optional: physical screen width, to report accuracy in degrees")
    ap.add_argument("--distance-cm", type=float,
                    help="optional: distance from the eye to the screen, in cm")
    args = ap.parse_args()

    CFG["calib_path"] = Path(args.calibration_file)
    CFG["screen_w_cm"] = args.screen_width_cm
    CFG["distance_cm"] = args.distance_cm
    load_calibration()

    if args.gaze_file:
        threading.Thread(
            target=bridge_gaze_file,
            args=(args.gaze_file, args.gain, 0.35, args.flip_x, args.flip_y),
            daemon=True,
        ).start()

    app.run(host=args.host, port=args.port, threaded=True, debug=False)


if __name__ == "__main__":
    main()
