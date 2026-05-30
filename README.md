# TaigiSpeech Local Recording Bundle

Offline local recording app for TaigiSpeech data collection. The participant-facing UI is Traditional Chinese by design; developer comments and project documentation are written in English for team collaboration.

## Requirements

- Python 3.6 or newer
- A modern browser with microphone access
- No pip packages are required

## Run Locally

Windows:

```bat
start-local.bat
```

macOS:

```bash
./start-local.command
```

Manual start:

```bash
python local_server.py
python local_server.py --port 5050
python local_server.py --no-browser
```

Then open `http://127.0.0.1:5050/`.

## Project Layout

- `index.html`, `style.css`, `script.js`: main recording UI
- `local_server.py`: local Python HTTP server and upload handler
- `local/mediarecorder-shim.js`: WAV recorder shim for older Safari and consistent local output
- `gemini_2026_pro_preview_0121_160_data_proof.json`: prompt metadata
- `videos/`: scenario videos named with four-digit indices
- `posters/`: poster images named with matching four-digit indices
- `assets/`: consent PDF and example video
- `recordings_local/`: local output folder, intentionally ignored by Git

## Data And GitHub Notes

Local participant recordings and profiles are written under `recordings_local/`; do not commit this folder. The bundled media files are large, so the repository is roughly 597 MB. Individual files are below GitHub's 100 MB hard limit, but the team may still want Git LFS if media changes frequently.
