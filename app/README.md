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

### Use the real tracker (demo only, not calibrated)

Start the tracker from its own folder, so it writes `gaze_vector.txt` there:

```
python app/server.py --gaze-file third_party/EyeTracker/3DTracker/gaze_vector.txt
```

Press **G** in the browser. If the dot moves the wrong way, add `--flip-x` or `--flip-y`; change
`--gain` to make it move more or less. This uses a fixed mapping from gaze direction to screen
position. Proper 9-point calibration replaces it later (see "Next steps").

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
