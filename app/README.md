# Eye Communicator (web app)

Flask server + browser UI. The patient looks at large boxes; looking at a box long enough selects it,
and the word is spoken from a saved audio clip. Communication runs locally, so no internet is needed
once the audio clips exist. Only the video panel needs internet.

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
hover over a box until its ring fills (3 s for a category, 5 s for a word), or click it.

## The screen

```
[ sentence so far ............ ][ Speak ][ Clear ][ I need help ]
[ Categories ]  [  video (YouTube)  ]  [ Words ]
[  (all 6)   ]  [ title            ]  [ 4 + More ]
[            ]  [ <<   play/pause  >> ] [         ]
```

- **Left:** all categories. The chosen one is outlined. **Right:** its words, 4 at a time. **More**
  shows the next 4 (and wraps around). The category stays open after a word, so several words from
  the same category can be said in a row.
- **Top:** the sentence being built, **Speak** (says the whole sentence), **Clear**, and **I need
  help**. Help shows a red full-screen alert, pauses the video and says "I need help. Please come
  here." again every 9 seconds until it is cancelled (look at *Cancel* for 3 s, or press **Esc**).
- **Middle:** a 16:9 YouTube video with your own big buttons: previous video, play/pause, next video,
  and a second row with **Quieter**, **Mute** (it also shows the volume as a percentage and a bar) and **Louder**.
  Choose the videos with **V** (see Video panel). Speaking lowers the video volume until it has finished.

### How selecting works (dwell rules)

Each box has its **own** look timer. Looking away *pauses* it (a dim ring shows the progress is kept);
it is forgotten only after the box has not been looked at for **15 seconds**. Selecting anything
clears the progress of all the other boxes, and the pointer must leave the box before it can fire
again. Times are in `vocab.json` under `"dwell"` (milliseconds):

| Box | Time | Why |
|-----|------|-----|
| word | 5000 | a wrong word is costly |
| category | 3000 | |
| nav (More) | 1500 | a mistake costs nothing, just look again |
| speak / clear / help | 3000 | accidental use is annoying |
| video buttons, mute | 1500 | easy to undo |
| volume (Quieter / Louder) | 1500, then every 600 | **hold**: keep looking and it keeps stepping 10% (`volume_repeat_ms`) |
| `memory_ms` | 15000 | how long unfinished progress is kept |
| `words_per_page` | 4 | |

For quick tests, `?dwell=800` sets every box to 800 ms and `?memory=3000` sets the memory time, `?repeat=300` the volume repeat speed.

### Volume

The level is the app's own (0 to 100 in steps of 10), remembered in the browser, and applied to the
video player. At 0% the player is muted. Louder also un-mutes. If the playback speed ever changes
(a YouTube shortcut), the app sets it back to normal. While the app is speaking, the video is lowered to at most 15%
and then returns to the chosen level.

### Video panel

Uses YouTube's embedded player, so it works from `http://localhost:5000` but needs internet.
Without internet the panel says so and everything else keeps working.

**Choosing the videos (no file editing):** a caregiver presses **V** (or clicks *Videos (V)* at the
bottom), pastes a YouTube **playlist** link and presses Save. The video panel switches to that
playlist right away (the page does not reload). Adding or removing videos is then done on YouTube itself. Notes:
- The playlist must be **Unlisted or Public** (private ones cannot be embedded). YouTube Mixes
  (ids starting `RD`), Watch later and Liked videos do not work; the app says so.
- A single video link works too, and *Use the built-in video* goes back to the default.
- The choice is saved by the server in `app/settings.json` (created automatically, safe to delete,
  not for git), so it is the same on every screen that opens the app.
- **Previous / Next** go through the playlist (it loops). With a single video they restart it.
- The video's owner must allow embedding; a video that cannot play is skipped, and the panel shows
  YouTube's error number. If the panel only says "YouTube is not answering", the playlist link is
  usually wrong or private; press **V** and try another.
- Looking cannot click inside the video, which is why the controls are separate boxes. Ads that
  YouTube inserts cannot be skipped by gaze; a caregiver can click them with the mouse. After
  clicking inside the video, keyboard shortcuts (G, C, ...) stop working until you click the page.

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
   only Redo is offered. You never have to go in order or finish all 9 first: all 9 numbered circles
   are always on screen, and you can **click a circle or press 1-9** to jump to that dot (a captured one
   is replaced when you accept a new capture), press **B** to go one dot back, or **C** to **restart**
   from dot 1. After you accept a dot, the app moves on to the next dot that is still missing.
5. The **border around the whole page** tells you how things are going: while aiming it shows how
   steady your gaze is right now (green: a good moment to press Capture, yellow: so-so, red: shaky,
   grey: no signal); after a capture it shows how steady that capture was; on the result screen it shows
   the overall quality. While you do this, a panel at the bottom shows the live gaze vector (x, y, z), the yaw and pitch in
   degrees, samples per second and steadiness, plus a plot of the raw angles: numbered blue points are
   the dots you accepted, the ring is where your eye is now. Dots that are far apart on screen should
   be far apart in the plot; if they bunch together, the tracker is not following your eye well.
6. After the 9th dot the result screen shows the estimated error and the 9 circles coloured by how well
   each dot fits (green good, yellow so-so, red poor). Click a circle, or press its number **1-9**, to
   redo just that dot. The blue cursor shows where the app thinks you are looking. **Enter** finishes,
   **C** redoes everything, **Esc** cancels at any time. (The same keys work during the 9 dots.) A red circle is not always the culprit: one bad
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
| V | choose the videos (caregiver) |
| Space / R | during calibration: capture or accept / redo the dot |
| 1-9 | on the result screen: redo that dot |
| Esc | cancel calibration |
| L | switch language (shown only once Thai labels exist) |
| F | fullscreen |

URL options: `?mode=gaze`, `?dwell=1500` (ms, all boxes), `?memory=3000` (ms), `?lang=th`, `?nostart=1`.

## Files

| Path | Purpose |
|------|---------|
| `server.py` | Flask server: `/api/gaze` (POST from tracker), `/api/stream` (SSE to browser), `/api/calibration` (GET/POST/DELETE), `/api/vocab`, `/api/video-source` |
| `vocab.json` | Categories, words, UI text, dwell times. Edit this to change the vocabulary |
| `settings.json` | Chosen video playlist (created by the app, do not commit) |
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

The Help phrase is saved as `ui_help.mp3` by the same script.

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
