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

## Running the pupil detector

```
python third_party\EyeTracker\OrloskyPupilDetector.py
```

Select `eye_test.mp4` if a file window opens.

## Web app

The web app that turns gaze into words (Flask server, calibration, categories and words,
spoken output) lives in [`app/`](app/). See [app/README.md](app/README.md) for how to run
it, calibrate, and test it with the tracker.

Quick start:

    python app\server.py --gaze-file gaze_vector.txt

(run the eye tracker from the repo root so it writes `gaze_vector.txt` there)