# Eye Communicator (web app)

Flask server + browser UI. The patient looks at large tiles; staying on a tile for about 1 second
selects it, and the word is spoken from a saved audio clip. Everything runs locally, so no internet is
needed once the audio clips exist.

```
tracker (Orlosky) --> gaze_vector.txt --> server.py --SSE--> browser UI --> speaker
                  \-- or POST /api/gaze --/
```

## Run (Phase 1, laptop)

From the repo root:

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
whatever tile it rests on.

## Test with the real tracker (demo only, not calibrated)

Use two terminals, both at the repo root with the venv active (`.venv\Scripts\Activate.ps1`).

**Terminal 1: the tracker**

```
python third_party\EyeTracker\3DTracker\Orlosky3DEyeTracker.py
```

Pick the camera and click **Start Camera**. Look around for about 20 seconds so the eye model settles,
and check that the yellow ellipse sits on the pupil.

The tracker writes `gaze_vector.txt` into the folder you launched it from. Launched from the repo root,
the file is `gaze_vector.txt` in the repo root.

**Terminal 2: the web server**

```
python app\server.py --gaze-file gaze_vector.txt
```

The path after `--gaze-file` must be the file the tracker is writing. If you launch the tracker from
another folder, use that folder's `gaze_vector.txt` instead.

Open http://localhost:5000, click once, and press **G** to switch to gaze mode.

| Badge | Meaning |
|-------|---------|
| Gaze: live | The tracker is writing new data and the dot follows your eye |
| Gaze: no signal | No new data: wrong file path, tracker closed, or pupil not detected |

### Troubleshooting

- **"Gaze: no signal" while the tracker runs:** the server is probably watching a different
  `gaze_vector.txt`. Run `Get-Content gaze_vector.txt` twice a few seconds apart; the numbers should
  change. If they do not, check the path given to `--gaze-file`.
- **"area was 0" in the tracker terminal:** the pupil was not found on that frame (blink, partly hidden
  pupil). A few are normal. A constant stream means detection is failing, so check the yellow ellipse.
- **`MSMF ... can't be used to capture by index` warnings:** harmless. The tracker is probing camera
  numbers that do not exist.
- **Dot moves the wrong way:** restart the server with `--flip-x` or `--flip-y`.
- **Dot moves too little or too much:** change `--gain` (for example `--gain 3` or `--gain 0.8`).
- Do not run `simulate_gaze.py` and `--gaze-file` together; they overwrite each other.

## Keys

| Key | Action |
|-----|--------|
| G | switch mouse / gaze input |
| L | switch language (shown only once Thai labels exist) |
| F | fullscreen |

URL options: `?mode=gaze`, `?dwell=1500` (ms), `?lang=th`, `?nostart=1`.

## Files

| Path | Purpose |
|------|---------|
| `server.py` | Flask server: `/api/gaze` (POST from tracker), `/api/stream` (SSE to browser), `/api/vocab` |
| `vocab.json` | Categories, words, UI text, dwell time. Edit this to change the vocabulary |
| `static/` | `index.html`, `style.css`, `app.js` (no external libraries, works offline) |
| `static/audio/<lang>/<id>.mp3` | One clip per word |
| `tools/make_audio.py` | Generates the clips (needs internet once) |
| `tools/simulate_gaze.py` | Fake tracker for testing |

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
again, and a language button appears. Have a native speaker check the translations.

## Raspberry Pi notes (Phase 2)

- Run `python app/server.py` at boot (a systemd service) and open the page in Chromium kiosk mode:
  `chromium-browser --kiosk --autoplay-policy=no-user-gesture-required http://localhost:5000/?mode=gaze&nostart=1`
  The autoplay flag matters: the patient cannot click, and otherwise the browser blocks audio.
- To show the page on a TV's own browser instead, run `python app/server.py --host 0.0.0.0` and open
  `http://<pi address>:5000` on the TV. Only do this on a trusted network.

## Next steps

1. Replace the fixed gaze mapping with a calibration screen (9 dots, fit pupil data to screen position).
2. Send real tracker output straight to `/api/gaze` instead of going through `gaze_vector.txt`.
3. Benchmark the tracker on a Raspberry Pi.
