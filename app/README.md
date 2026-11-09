# Eye Communicator (web app)

Flask server + browser UI. The patient looks at large tiles; staying on a tile for about 1 second
selects it, and the word is spoken from a saved audio clip. Everything runs locally, so no internet is
needed once the audio clips exist.

```
tracker (Orlosky) --> gaze_vector.txt --> server.py --SSE--> browser UI --> speaker
                  \-- or POST /api/gaze --/        \-- calibration: raw gaze angles -> screen position
```

## Run (Phase 1, laptop)

From the repo root, with the venv active:

```
pip install -r requirements.txt
python app/server.py
```

Open http://localhost:5000, click once (this lets the browser play audio), then use the mouse:
hover over a tile for 1 second, or click it.

### Try gaze mode with no glasses

In a second terminal:

```
python app/tools/simulate_gaze.py --hold 0.2 0.3
```

Then press **G** in the browser to switch to gaze mode. The cyan dot is the "gaze" and it selects
whatever tile it rests on. (The simulator sends screen positions directly, so it cannot be calibrated.)

## Test with the real tracker

Use two terminals, both at the repo root with the venv active (`.venv\Scripts\Activate.ps1`).

**Terminal 1: the tracker**

```
python third_party\EyeTracker\3DTracker\Orlosky3DEyeTracker.py
```

Pick the camera and click **Start Camera**. Look around for about 20 seconds so the eye model settles,
check that the yellow ellipse sits on the pupil, then press **F** in the tracker window to freeze the
eye model ("Eye sphere adjustment: affixed"). Do this before calibrating (see below).

The tracker writes `gaze_vector.txt` into the folder you launched it from. Launched from the repo root,
the file is `gaze_vector.txt` in the repo root.

**Terminal 2: the web server**

```
python app\server.py --gaze-file gaze_vector.txt
```

The path after `--gaze-file` must be the file the tracker is writing. If you launch the tracker from
another folder, use that folder's `gaze_vector.txt` instead.

Open http://localhost:5000, click once, and press **G** to switch to gaze mode.

| Badge (bottom left) | Meaning |
|---------------------|---------|
| Gaze: live | The tracker is writing new data and the dot follows your eye |
| Gaze: no signal | No new data: wrong file path, tracker closed, or pupil not detected |
| Calibrated (~x% error) / Not calibrated | Whether a calibration is loaded, and its estimated accuracy |

Before calibration the dot uses a fixed guess (`--gain`, `--flip-x`, `--flip-y`), so it will be off,
especially near the edges. Calibrate to fix that.

## Calibrate (so the edges work)

Calibration teaches the app how *your* eye angles map to *your* screen.

1. Make the browser fullscreen (**F**) on the screen you will use, sit as you will during use, and
   keep your head still.
2. Make sure the tracker is steady: yellow ellipse on the pupil, and the eye model frozen with **F** in
   the tracker window. If the model keeps adjusting itself, the calibration goes stale.
3. In the browser press **C** (or click *Calibrate*). It switches to gaze mode if needed.
4. Nothing is timed. For each of the 9 dots: look at the dot, take your time, then press **Space**
   (or click *Capture*). The app measures for about 1.3 seconds, then shows how steady your gaze was
   (green: under 1 degree, yellow: up to 2.5, red: more). Press **Space** to *Accept* if you were
   really looking at the dot, or **R** to *Redo* it. If the tracker lost your eye (too few samples),
   only Redo is offered.
5. While you do this, a panel at the bottom shows the live gaze vector (x, y, z), the yaw and pitch in
   degrees, samples per second and steadiness, plus a plot of the raw angles: numbered blue points are
   the dots you accepted, the ring is where your eye is now. Dots that are far apart on screen should
   be far apart in the plot; if they bunch together, the tracker is not following your eye well.
6. After the 9th dot the result screen shows the estimated error and the 9 circles coloured by how well
   each dot fits (green good, yellow so-so, red poor). Click a circle, or press its number **1-9**, to
   redo just that dot. The blue cursor shows where the app thinks you are looking. **Enter** finishes,
   **C** redoes everything, **Esc** cancels at any time. A red circle is not always the culprit: one bad
   dot also drags the fit of its neighbours, so redo the one that looked shaky or that you doubt first.

| Estimated error | Meaning |
|-----------------|---------|
| 5% or less | Good |
| 5% to 10% | Usable with large tiles; consider redoing |
| Over 10% | Poor: redo, check head position, camera and eye-model freeze |

The estimate is a leave-one-out error: each dot is left out in turn, the mapping is fitted to the other
eight, and the miss for the left-out dot is measured. It is a more honest number than the error on the
dots themselves, and a little pessimistic for the corner dots.

The mapping is saved to `app/calibration.json` and reloaded when the server restarts. **Recalibrate
whenever the glasses slip, the camera moves, or a different person uses it.** Do not commit
`calibration.json` (add it to `.gitignore`); it belongs to one person and one setup.

To report accuracy in degrees (useful for the project report), tell the server your screen width and
viewing distance:

```
python app\server.py --gaze-file gaze_vector.txt --screen-width-cm 34 --distance-cm 60
```

### How it works

- The tracker's gaze vector is turned into two angles (yaw, pitch) and sent to the page as `raw`.
- At each dot the page keeps the median of the raw angles (after 0.8 s for the eye to settle), so a
  blink or a stray sample cannot spoil a point.
- The server fits two models by least squares: *affine* (flat mapping) and *quadratic* (allows some
  curve). It keeps the one with the smaller leave-one-out error, and applies it to every later sample.
  The fit also corrects flipped axes, so `--flip-x`/`--flip-y` are not needed after calibration.
- Positions are clamped to the screen, and a calibration made while the tracker was frozen or lost
  (the raw values do not change between dots) is rejected.

## Troubleshooting

- **"Gaze: no signal" while the tracker runs:** the server is probably watching a different
  `gaze_vector.txt`. Run `Get-Content gaze_vector.txt` twice a few seconds apart; the numbers should
  change. If they do not, check the path given to `--gaze-file`.
- **"area was 0" in the tracker terminal:** the pupil was not found on that frame (blink, partly hidden
  pupil). A few are normal. A constant stream means detection is failing, so check the yellow ellipse.
- **`MSMF ... can't be used to capture by index` warnings:** harmless. The tracker is probing camera
  numbers that do not exist.
- **Calibration says "only N samples":** the tracker produced almost no new data while capturing.
  Check that it is running and detecting the pupil, then press **R** to redo the dot.
- **Calibration says the gaze values barely changed:** the tracker was not following your eye
  (frozen or detecting something else).
- **Error stays high after a few tries:** check that the eye model is frozen, the glasses are not
  moving, and the yellow ellipse is stable on every dot. Use the live panel: shaky readings
  (steadiness over about 2.5 degrees) mean detection is unstable; raise `CAL_COLLECT_MS` at the top of
  the calibration section in `static/app.js` for a longer measurement.
- Do not run `simulate_gaze.py` and `--gaze-file` together; they overwrite each other.

## Keys

| Key | Action |
|-----|--------|
| G | switch mouse / gaze input |
| C | calibrate (9 dots) |
| Space / R | during calibration: capture or accept / redo the dot |
| 1-9 | on the result screen: redo that dot |
| Esc | cancel calibration |
| L | switch language (shown only once Thai labels exist) |
| F | fullscreen |

URL options: `?mode=gaze`, `?dwell=1500` (ms), `?lang=th`, `?nostart=1`.

## Files

| Path | Purpose |
|------|---------|
| `server.py` | Flask server: `/api/gaze` (POST from tracker), `/api/stream` (SSE to browser), `/api/calibration` (GET/POST/DELETE), `/api/vocab` |
| `vocab.json` | Categories, words, UI text, dwell time. Edit this to change the vocabulary |
| `static/` | `index.html`, `style.css`, `app.js` (no external libraries, works offline) |
| `static/audio/<lang>/<id>.mp3` | One clip per word |
| `calibration.json` | Saved calibration (created by the app, do not commit) |
| `tools/make_audio.py` | Generates the clips (needs internet once) |
| `tools/simulate_gaze.py` | Fake tracker for testing |

### Sending data from your own tracker code

`POST /api/gaze` accepts either a screen position or raw gaze angles in radians:

```
{"x": 0.4, "y": 0.7}            # already a screen position (0..1)
{"raw": [yaw, pitch]}           # mapped to the screen if a calibration exists
```

Posting `raw` straight from the tracker (instead of going through `gaze_vector.txt`) is the planned
Phase 2 design.

## Audio

If a clip is missing, the page falls back to the browser's built-in voice, so the demo works before
you generate anything. For the real device, generate and commit the clips:

```
pip install gTTS
python app/tools/make_audio.py
```

You can replace any clip with a recording of a family member's voice (same file name).

## Adding Thai

Fill in the `"th": ""` fields in `vocab.json` (words, categories and `ui`), run `make_audio.py`
again, and a language button appears. Have a native speaker check the translations. The calibration
screen text is English only, since it is used by the person setting the device up.

## Raspberry Pi notes (Phase 2)

- Run `python app/server.py` at boot (a systemd service) and open the page in Chromium kiosk mode:
  `chromium-browser --kiosk --autoplay-policy=no-user-gesture-required http://localhost:5000/?mode=gaze&nostart=1`
  The autoplay flag matters: the patient cannot click, and otherwise the browser blocks audio.
- To show the page on a TV's own browser instead, run `python app/server.py --host 0.0.0.0` and open
  `http://<pi address>:5000` on the TV. Only do this on a trusted network.
- Calibration is started by a caregiver with the keyboard (**C**), or by opening the page on another
  device with a keyboard. A tile that starts calibration by gaze is not built yet.

## Next steps

1. Send real tracker output straight to `/api/gaze` instead of going through `gaze_vector.txt`.
2. Benchmark the tracker on a Raspberry Pi.
3. Drift handling: a quick one-dot recheck instead of redoing all 9 dots when the glasses slip.
