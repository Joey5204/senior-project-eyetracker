"""Fake tracker: pushes gaze samples to the server so you can test gaze mode with no glasses.

    python app/tools/simulate_gaze.py                  # wander around the screen
    python app/tools/simulate_gaze.py --hold 0.2 0.3   # sit at 20% across, 30% down (with tiny jitter)

Coordinates are screen-normalised: (0,0) top-left, (1,1) bottom-right.
Uses only the standard library.
"""
import argparse
import json
import math
import random
import time
import urllib.request


def post(url, x, y):
    body = json.dumps({"x": x, "y": y}).encode()
    req = urllib.request.Request(url, body, {"Content-Type": "application/json"})
    urllib.request.urlopen(req, timeout=2).read()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:5000/api/gaze")
    ap.add_argument("--hz", type=float, default=30)
    ap.add_argument("--hold", nargs=2, type=float, metavar=("X", "Y"),
                    help="stay near this point instead of wandering")
    ap.add_argument("--jitter", type=float, default=0.004, help="random noise (fraction of screen)")
    args = ap.parse_args()

    t0 = time.time()
    print(f"Sending gaze to {args.url} at {args.hz:.0f} Hz. Ctrl+C to stop.")
    try:
        while True:
            t = time.time() - t0
            if args.hold:
                x, y = args.hold
            else:
                x = 0.5 + 0.38 * math.sin(t * 0.35)
                y = 0.5 + 0.35 * math.sin(t * 0.53 + 1.0)
            x += random.gauss(0, args.jitter)
            y += random.gauss(0, args.jitter)
            post(args.url, x, y)
            time.sleep(1 / args.hz)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
