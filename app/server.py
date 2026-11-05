"""Eye-communication web server (Flask).

Runs on the same machine as the tracker (laptop now, Raspberry Pi later).

    tracker  --POST /api/gaze-->  server  --SSE /api/stream-->  browser UI

The browser UI also works with no tracker at all (mouse mode), so the UI can be
developed and demoed without the glasses.

Run:
    python app/server.py                       # mouse mode only
    python app/server.py --gaze-file PATH      # also bridge the tracker's gaze_vector.txt
Then open http://localhost:5000
"""
import argparse
import json
import queue
import threading
import time
from pathlib import Path

from flask import Flask, Response, jsonify, request, send_from_directory

APP_DIR = Path(__file__).resolve().parent
STATIC_DIR = APP_DIR / "static"
VOCAB_PATH = APP_DIR / "vocab.json"

app = Flask(__name__, static_folder=str(STATIC_DIR), static_url_path="/static")

# --------------------------------------------------------------------------
# Gaze broadcast (latest-value-wins, so a slow browser never builds a backlog)
# --------------------------------------------------------------------------
_subscribers = []
_sub_lock = threading.Lock()
_latest = {"gaze": None, "time": 0.0}


def publish_gaze(sample):
    """sample: dict with x, y in 0..1 (screen-normalised) plus optional extras."""
    sample = dict(sample)
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
    return max(0.0, min(1.0, float(v)))


@app.post("/api/gaze")
def api_gaze():
    """Tracker pushes a sample: {"x": 0..1, "y": 0..1, "confidence": 0..1 (optional)}."""
    data = request.get_json(silent=True) or {}
    try:
        sample = {"x": _clamp01(data["x"]), "y": _clamp01(data["y"])}
    except (KeyError, TypeError, ValueError):
        return jsonify(error="body must be JSON with numeric x and y in 0..1"), 400
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
    )


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
# This is NOT calibrated. It maps the gaze direction to the screen with a fixed
# gain so you can see live data move the cursor. Real calibration (9-point fit)
# replaces this function later.
def bridge_gaze_file(path, gain=1.5, smoothing=0.35, flip_x=False, flip_y=False):
    path = Path(path)
    sx = sy = None
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
        gx, gy = vals[3], vals[4]
        x = 0.5 + (-gx if flip_x else gx) * gain
        y = 0.5 + (gy if flip_y else -gy) * gain
        x, y = _clamp01(x), _clamp01(y)
        sx = x if sx is None else sx + smoothing * (x - sx)
        sy = y if sy is None else sy + smoothing * (y - sy)
        publish_gaze({"x": sx, "y": sy, "source": "gaze_vector.txt"})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1",
                    help="use 0.0.0.0 to let another device (e.g. a TV) reach it")
    ap.add_argument("--port", type=int, default=5000)
    ap.add_argument("--gaze-file", help="path to the tracker's gaze_vector.txt")
    ap.add_argument("--gain", type=float, default=1.5)
    ap.add_argument("--flip-x", action="store_true")
    ap.add_argument("--flip-y", action="store_true")
    args = ap.parse_args()

    if args.gaze_file:
        threading.Thread(
            target=bridge_gaze_file,
            args=(args.gaze_file, args.gain, 0.35, args.flip_x, args.flip_y),
            daemon=True,
        ).start()

    app.run(host=args.host, port=args.port, threaded=True, debug=False)


if __name__ == "__main__":
    main()
