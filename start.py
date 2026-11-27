#!/usr/bin/env python3
"""One-step start: web server + eye tracker + browser.

Run from anywhere, with the virtual environment active:

    python start.py                 # server, tracker, then the browser in gaze mode
    python start.py --no-tracker    # server and browser only (mouse testing)
    python start.py --no-browser    # do not open the browser
    python start.py --port 5001     # use another port

The tracker opens its own small window: pick the camera and click "Start Camera".
Press Ctrl+C in this window to stop everything.
"""
import argparse
import importlib.util
import signal
import socket
import subprocess
import sys
import time
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SERVER = ROOT / "app" / "server.py"
TRACKER = ROOT / "third_party" / "EyeTracker" / "3DTracker" / "Orlosky3DEyeTracker.py"
# The tracker writes gaze_vector.txt into the folder it is launched from, so it is launched from ROOT.
GAZE_FILE = ROOT / "gaze_vector.txt"


def missing_modules(names):
    return [n for n in names if importlib.util.find_spec(n) is None]


def wait_for_port(host, port, server, seconds=20):
    """True once the server accepts connections; False if it exits or takes too long."""
    deadline = time.time() + seconds
    while time.time() < deadline:
        if server.poll() is not None:
            return False
        try:
            with socket.create_connection((host, port), timeout=0.5):
                return True
        except OSError:
            time.sleep(0.2)
    return False


def stop(proc, name):
    if proc is None or proc.poll() is not None:
        return
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
    print(f"[start] stopped {name}")


def main():
    ap = argparse.ArgumentParser(description="Start the Eye Communicator server and the eye tracker.")
    ap.add_argument("--port", type=int, default=5000)
    ap.add_argument("--no-tracker", action="store_true", help="do not start the eye tracker")
    ap.add_argument("--no-browser", action="store_true", help="do not open the browser")
    ap.add_argument("--tracker", default=str(TRACKER), help="path to the tracker script")
    args = ap.parse_args()

    need = ["flask"] + ([] if args.no_tracker else ["cv2", "numpy", "tkinter"])
    missing = missing_modules(need)
    if missing:
        sys.exit(f"Missing Python packages: {', '.join(missing)}.\n"
                 "Activate the virtual environment first (.venv\\Scripts\\Activate.ps1 on Windows) and run:\n"
                 "    pip install -r requirements.txt")

    # An old gaze file would show one stale sample before the tracker starts writing.
    try:
        GAZE_FILE.unlink()
    except FileNotFoundError:
        pass
    except OSError as err:
        print(f"[start] could not remove the old {GAZE_FILE.name}: {err}")

    # A closed terminal or `kill` should stop the children too, not leave them running.
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    server_cmd = [sys.executable, str(SERVER), "--port", str(args.port)]
    if not args.no_tracker:
        server_cmd += ["--gaze-file", str(GAZE_FILE)]
    print("[start] starting the web server ...")
    server = subprocess.Popen(server_cmd, cwd=str(ROOT))
    tracker = None
    try:
        if not wait_for_port("127.0.0.1", args.port, server):
            sys.exit("[start] the server did not start (is port %d already in use?). "
                     "Check the messages above." % args.port)

        url = f"http://localhost:{args.port}/"
        if not args.no_tracker:
            url += "?mode=gaze"
            print("[start] starting the eye tracker: pick the camera and click Start Camera.")
            tracker = subprocess.Popen([sys.executable, args.tracker], cwd=str(ROOT))
        if not args.no_browser:
            webbrowser.open(url)
        print(f"[start] page: {url}")
        print("[start] press Ctrl+C here to stop everything.")

        told = False
        while True:
            time.sleep(0.5)
            if server.poll() is not None:
                print("[start] the server stopped.")
                break
            if tracker is not None and tracker.poll() is not None and not told:
                told = True
                print("[start] the tracker window was closed. The server is still running; "
                      "press Ctrl+C to stop it, or restart everything.")
    except KeyboardInterrupt:
        print("\n[start] stopping ...")
    finally:
        stop(tracker, "tracker")
        stop(server, "server")


if __name__ == "__main__":
    main()