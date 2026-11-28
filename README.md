# Eye-Tracking Communication Glasses
 
A senior project: glasses with a small IR camera let a person who cannot speak choose words on a screen
by looking at them. The words are spoken aloud. Everything runs locally at the current moment but is planned to be deployed on the cloud.
 
```
glasses + IR camera --> eye tracker (Orlosky 3D) --> web app (Flask) --> screen + spoken words
```
 
- `third_party/EyeTracker/` is the open-source Orlosky eye tracker we use
  ([JEOresearch/EyeTracker](https://github.com/JEOresearch/EyeTracker)).
- `app/` is the web app that turns gaze into words. See [app/README.md](app/README.md).
- [documentation.md](documentation.md) records what we tried, what did not work, and why.
## Installation
 
1. Clone the repo:
```
   git clone https://github.com/Joey5204/senior-project-eyetracker.git
   cd senior-project-eyetracker
```
2. Create and activate a virtual environment (Windows PowerShell):
```
   python -m venv .venv
   .venv\Scripts\Activate.ps1
```
3. Install dependencies:
```
   pip install -r requirements.txt
```
 
`requirements.txt` pins `numpy==1.26.4` and `opencv-python==4.11.0.86` on purpose: with numpy 2.x the
tracker's pupil detection breaks. Do not upgrade them.
 
## Start everything (one step)
 
With the virtual environment active, from anywhere:
 
```
python start.py
```
 
This starts the web server, opens the page in gaze mode, and starts the eye tracker. In the small tracker window pick the camera (the list shows its name, for example `0: USB Camera`)
and click **Start Camera**. Press **Ctrl+C** in the terminal to stop
everything.
 
| Command | What it does |
|---------|--------------|
| `python start.py` | server + tracker + browser (gaze mode) |
| `python start.py --no-tracker` | server + browser only, for testing with the mouse |
| `python start.py --no-browser` | do not open the browser |
| `python start.py --port 5001` | use another port |
 
First-time setup, done once per person and device: let the tracker settle for about 20 seconds, check
that the yellow ellipse sits on the pupil, press **F** in the tracker window to freeze the eye model,
then press **C** on the page to calibrate. Details are in [app/README.md](app/README.md).
 
## Start the parts separately
 
Use two terminals, both at the repo root with the virtual environment active.
 
Tracker:
 
```
python third_party\EyeTracker\3DTracker\Orlosky3DEyeTracker.py
```
 
Web server:
 
```
python app\server.py --gaze-file gaze_vector.txt
```
 
The tracker writes `gaze_vector.txt` into the folder you launch it from, so launch it from the repo
root. To try the tracker without a camera, click **Browse Video** instead of **Start Camera** and pick
`third_party\EyeTracker\eye_test.mp4`.
 
Tracker keys: **F** freezes or unfreezes the eye model, **E** turns saving of sample ellipses on or off and
**C** clears them, **Space** pauses, **Q** quits.
 
## Spoken words
 
The web app plays pre-generated audio clips, and falls back to the browser's voice if a clip is
missing. The clips are not stored in the repo, so generate them once (needs internet):
 
```
pip install gTTS
python app\tools\make_audio.py
```
 
## Troubleshooting
 
| Problem | What to try |
|---------|-------------|
| Page says "Gaze: no signal" | The tracker is not running, or it was launched from another folder. Use `python start.py`, or see "Start the parts separately" above. |
| Tracker window closes right after **Start Camera** (`MSMF ... can't grab frame`) | Unplug the camera, plug it back in, and try again. Also close any other program using the camera, and end leftover `python.exe` processes. |
| Many `MSMF ... can't be used to capture by index` warnings at startup | Harmless: the tracker is checking camera numbers 0-9. |
| Yellow ellipse is off the pupil | A bright reflection can cover part of the pupil. Move the camera or LED slightly, or try another angle. See [documentation.md](documentation.md). |
| Camera list shows only numbers, no names | On Windows run `pip install pygrabber` (it is in `requirements.txt`, so `pip install -r requirements.txt` also installs it). Names appear automatically on Linux / Raspberry Pi. |
 
## Web app
 
The web app (Flask server, calibration, categories and words, spoken output) lives in
[`app/`](app/). See [app/README.md](app/README.md) for the screen, the selection rules, calibration, the
video panel, and testing without the tracker.
 