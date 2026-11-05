"""Generate one audio clip per vocabulary word, so the device never needs internet to speak.

Run this once on your laptop (it needs internet while generating), then commit the
resulting files in app/static/audio/. The Pi only plays the saved files.

    pip install gTTS
    python app/tools/make_audio.py              # english + any thai labels you filled in
    python app/tools/make_audio.py --force      # regenerate everything

Files are written to app/static/audio/<lang>/<word id>.mp3
A family member's voice can replace any clip: just save a recording with the same name.
"""
import argparse
import json
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent.parent
VOCAB = APP_DIR / "vocab.json"
OUT = APP_DIR / "static" / "audio"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true", help="overwrite existing clips")
    args = ap.parse_args()

    try:
        from gtts import gTTS
    except ImportError:
        raise SystemExit("Install it first:  pip install gTTS")

    vocab = json.loads(VOCAB.read_text(encoding="utf-8"))
    made = skipped = 0
    for cat in vocab["categories"]:
        for word in cat["words"]:
            for lang in vocab["languages"]:
                text = (word["label"].get(lang) or "").strip()
                if not text:
                    continue  # no translation yet
                path = OUT / lang / f"{word['id']}.mp3"
                if path.exists() and not args.force:
                    skipped += 1
                    continue
                path.parent.mkdir(parents=True, exist_ok=True)
                gTTS(text=text, lang=lang).save(str(path))
                print("wrote", path.relative_to(APP_DIR))
                made += 1
    print(f"done: {made} written, {skipped} already existed")


if __name__ == "__main__":
    main()
