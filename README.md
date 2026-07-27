# TaigiSpeech — Offline Speech Data Collection App

[![Project](https://img.shields.io/badge/Project-TaigiSpeech-1f6feb?style=flat-square)](https://kwchang.org/taigispeech/)
[![arXiv](https://img.shields.io/badge/arXiv-2603.21478-B31B1B?style=flat-square)](https://arxiv.org/abs/2603.21478)
[![Smoke](https://github.com/ag027592/TaigiSpeech/actions/workflows/smoke.yml/badge.svg)](https://github.com/ag027592/TaigiSpeech/actions/workflows/smoke.yml)
[![License](https://img.shields.io/badge/License-MIT-green?style=flat-square)](LICENSE)

Privacy-conscious, offline recording software used to collect **TaigiSpeech**, a
real-world Taiwanese Hokkien speech intent dataset for eldercare voice
assistants.

The participant-facing interface is intentionally written in Traditional
Chinese. Developer documentation and source comments use English for research
collaboration.

## Why this app exists

Collecting speech from older adults in realistic home scenarios creates
constraints that a normal web survey does not solve:

- study locations may have unreliable or no internet access
- older macOS / Safari systems may not implement `MediaRecorder`
- recordings and participant metadata must not leave the collection laptop
  before researcher review and consent
- prompts require synchronized scenario video, keyboard-accessible controls,
  and bilingual recording modes

This bundle therefore runs on `localhost`, has **no third-party Python
dependencies**, records mono 16-bit PCM WAV, and stores output only under the
gitignored `recordings_local/` directory.

## System design

```text
Participant browser
  ├─ index.html / style.css / script.js
  ├─ scenario video + poster
  └─ MediaRecorder or Safari WAV shim
                 │ localhost only
                 ▼
Python standard-library server
  ├─ strict file allowlist
  ├─ path / filename sanitization
  └─ recordings_local/<participant>/<session>/
```

The local server does not require Flask, ffmpeg, a database, or a cloud
account. `local/mediarecorder-shim.js` supplies Web Audio API PCM-to-WAV
recording for older Safari versions.

## Quick start

Requirements:

- Python 3.6+
- a browser with microphone permission
- no pip packages

Windows:

```bat
start-local.bat
```

macOS:

```bash
chmod +x start-local.command
./start-local.command
```

Manual start:

```bash
python local_server.py --port 5050
```

Open `http://127.0.0.1:5050/`. See
[`本機錄音_使用說明.md`](本機錄音_使用說明.md) for the complete field guide.

## Repository layout

- `index.html`, `style.css`, `script.js` — participant recording UI
- `local_server.py` — local HTTP server and upload handler
- `local/mediarecorder-shim.js` — WAV recorder fallback for older Safari
- `gemini_2026_pro_preview_0121_160_data_proof.json` — prompt metadata
- `videos/`, `posters/` — paired scenario media
- `assets/` — consent document and example video
- `recordings_local/` — local output; intentionally excluded from Git

## Privacy and data handling

This public repository contains **software and study prompts, not participant
recordings**.

- Never commit `recordings_local/` or `recordings/`.
- Review collected sessions on the study laptop before any approved transfer.
- Do not file GitHub issues containing names, phone numbers, recordings, or
  other participant information.
- The included consent material is provided for this study workflow; reuse
  requires the appropriate ethics / IRB approval.

## Repository size

The full offline bundle includes hundreds of scenario videos and posters and is
therefore large. For a faster developer checkout, use:

```bash
git clone --depth 1 https://github.com/ag027592/TaigiSpeech.git
```

Media is intentionally bundled so the field app remains usable with no network
connection. Future media revisions should be distributed as versioned release
bundles rather than repeatedly added to Git history.

## Citation

Please cite:

> Kai-Wei Chang, Yi-Cheng Lin, Huang-Cheng Chou, et al. “TaigiSpeech: A
> Low-Resource Real-World Speech Intent Dataset and Preliminary Results with
> Scalable Data Mining In-the-Wild.” arXiv:2603.21478, 2026.

Machine-readable citation metadata is available in [`CITATION.cff`](CITATION.cff).

## License

The recording software is released under the [MIT License](LICENSE). Dataset,
media, consent materials, and participant data may be subject to separate
research-use and ethics requirements.
