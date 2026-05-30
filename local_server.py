"""
TaigiSpeech offline local recording server.

Design notes:
- Reuse the online UI from the project root: index.html, style.css, and script.js.
- Inject one local MediaRecorder shim before script.js so older Safari versions can
  record and all supported platforms save WAV output consistently.
- Avoid ffmpeg on the backend. Uploaded audio is detected from the RIFF/WAVE
  header and saved directly.
- Store local recordings in recordings_local/ so they stay separate from the
  online recordings/ layout.

Usage:
    python local_server.py
    python local_server.py --port 5050
    python local_server.py --no-browser
"""
from __future__ import annotations

import argparse
import json
import mimetypes
import os
import re
import socketserver
import sys
import threading
import time
import webbrowser
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler
from typing import Optional, Tuple
from urllib.parse import unquote, urlparse


REPO_ROOT = os.path.dirname(os.path.abspath(__file__))
LOCAL_DIR = os.path.join(REPO_ROOT, 'local')
RECORDINGS_DIR = os.environ.get(
    'RECORDINGS_LOCAL_DIR', os.path.join(REPO_ROOT, 'recordings_local')
)
PROOF_SOURCE_JSON = os.path.join(REPO_ROOT, 'gemini_2026_pro_preview_0121_160_data_proof.json')

# Inject this polyfill into index.html before <script src="script.js">.
SHIM_TAG = '<script src="/local/mediarecorder-shim.js"></script>'

# Root allowlist for browser-visible files. Prevents arbitrary path traversal.
SAFE_ROOTS = {
    'local': LOCAL_DIR,
    'videos': os.path.join(REPO_ROOT, 'videos'),
    'posters': os.path.join(REPO_ROOT, 'posters'),
    'assets': os.path.join(REPO_ROOT, 'assets'),
}

# Individual project-root files required by the online UI.
ROOT_FILES = {
    '/style.css': os.path.join(REPO_ROOT, 'style.css'),
    '/script.js': os.path.join(REPO_ROOT, 'script.js'),
    '/gemini_2026_pro_preview_0121_160_data_proof.json': PROOF_SOURCE_JSON,
}

# Windows mimetypes may miss some of these.
mimetypes.add_type('audio/wav', '.wav')
mimetypes.add_type('audio/webm', '.webm')
mimetypes.add_type('video/mp4', '.mp4')
mimetypes.add_type('image/jpeg', '.jpg')
mimetypes.add_type('text/javascript', '.js')
mimetypes.add_type('application/pdf', '.pdf')


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec='seconds')


def safe_folder_name(s: str) -> str:
    if not isinstance(s, str):
        return ''
    s = s.strip()
    if not s:
        return ''
    cleaned = re.sub(r'[\\/*?:"<>|]', '', s)
    return cleaned[:128]


def normalize_contact(s: str) -> str:
    if not isinstance(s, str):
        return ''
    return re.sub(r'\D', '', s)


def list_video_indices() -> list:
    videos_dir = SAFE_ROOTS['videos']
    out = set()
    if os.path.isdir(videos_dir):
        for fn in os.listdir(videos_dir):
            m = re.match(r'^(\d{4})\.mp4$', fn, re.IGNORECASE)
            if m:
                out.add(m.group(1))
    return sorted(out)


def parse_multipart(body: bytes, content_type: str) -> dict:
    """Very small multipart/form-data parser that avoids importing cgi.

    Returns a mapping from field name to either a string or (filename, bytes).
    """
    m = re.search(r'boundary=(?:"([^"]+)"|([^;]+))', content_type, re.I)
    if not m:
        raise ValueError('no boundary')
    boundary = (m.group(1) or m.group(2)).strip()
    sep = ('--' + boundary).encode()
    closing = ('--' + boundary + '--').encode()

    out = {}
    parts = body.split(sep)
    for part in parts:
        if not part or part == b'--' or part.startswith(b'--'):
            continue
        part = part.strip(b'\r\n')
        if not part or b'\r\n\r\n' not in part:
            continue
        head_raw, _, content = part.partition(b'\r\n\r\n')
        if content.endswith(b'\r\n'):
            content = content[:-2]
        if content.endswith(closing):
            content = content[: -len(closing)]
        head = head_raw.decode('utf-8', errors='replace')
        nm = re.search(r'name="([^"]+)"', head)
        if not nm:
            continue
        name = nm.group(1)
        fnm = re.search(r'filename="([^"]*)"', head)
        if fnm:
            out[name] = (fnm.group(1), content)
        else:
            try:
                out[name] = content.decode('utf-8')
            except UnicodeDecodeError:
                out[name] = content
    return out


def is_wav(content: bytes) -> bool:
    return len(content) >= 12 and content[:4] == b'RIFF' and content[8:12] == b'WAVE'


def find_user_folder(full_name: str, contact: str) -> Tuple[Optional[str], Optional[str]]:
    """Find a recordings_local/ folder with the same fullName and normalized contact."""
    if not full_name or not contact:
        return None, None
    norm = normalize_contact(contact)
    if not os.path.isdir(RECORDINGS_DIR):
        return None, None
    try:
        for folder in os.listdir(RECORDINGS_DIR):
            profile = os.path.join(RECORDINGS_DIR, folder, 'user_profile.json')
            if not os.path.exists(profile):
                continue
            try:
                with open(profile, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                p = data.get('profile') or {}
                if p.get('fullName') == full_name and normalize_contact(p.get('contact', '')) == norm:
                    return folder, data.get('userId')
            except Exception:
                continue
    except Exception:
        pass
    return None, None


class Handler(BaseHTTPRequestHandler):
    server_version = 'TaigiSpeechLocal/1.0'

    _print_lock = threading.Lock()

    def log_message(self, fmt, *args):
        with self._print_lock:
            sys.stdout.write('[%s] %s\n' % (self.log_date_time_string(), fmt % args))
            sys.stdout.flush()

    # ---------- Shared helpers ----------

    def _send_json(self, status: int, payload: dict):
        body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def _send_bytes(self, content: bytes, ctype: str, *, status: int = 200, headers: Optional[dict] = None):
        self.send_response(status)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(content)))
        self.send_header('Cache-Control', 'no-store')
        if headers:
            for k, v in headers.items():
                self.send_header(k, v)
        self.end_headers()
        self.wfile.write(content)

    def _send_file(self, abs_path: str):
        if not os.path.isfile(abs_path):
            self.send_error(HTTPStatus.NOT_FOUND, 'File not found')
            return
        ctype, _ = mimetypes.guess_type(abs_path)
        if not ctype:
            ctype = 'application/octet-stream'
        if ctype.startswith(('text/', 'application/json', 'application/javascript')):
            ctype = ctype + '; charset=utf-8'
        try:
            with open(abs_path, 'rb') as f:
                data = f.read()
        except OSError:
            self.send_error(HTTPStatus.INTERNAL_SERVER_ERROR, 'Read error')
            return
        self._send_bytes(data, ctype)

    def _safe_join(self, root_key: str, rel: str) -> Optional[str]:
        root = SAFE_ROOTS.get(root_key)
        if not root:
            return None
        rel = unquote(rel).lstrip('/')
        candidate = os.path.realpath(os.path.join(root, rel))
        root_real = os.path.realpath(root)
        if not (candidate == root_real or candidate.startswith(root_real + os.sep)):
            return None
        return candidate

    # ---------- Home page with injected shim ----------

    def _serve_index(self):
        index_path = os.path.join(REPO_ROOT, 'index.html')
        if not os.path.isfile(index_path):
            return self.send_error(HTTPStatus.NOT_FOUND, 'index.html not found')
        try:
            with open(index_path, 'r', encoding='utf-8') as f:
                html = f.read()
        except OSError:
            return self.send_error(HTTPStatus.INTERNAL_SERVER_ERROR, 'Read error')
        if SHIM_TAG not in html:
            html = html.replace(
                '<script src="script.js"></script>',
                SHIM_TAG + '\n    <script src="script.js"></script>',
                1,
            )
        body = html.encode('utf-8')
        self._send_bytes(body, 'text/html; charset=utf-8')

    # ---------- routes ----------

    def do_GET(self):
        url = urlparse(self.path)
        path = url.path

        if path in ('/', '/index.html'):
            return self._serve_index()

        if path == '/health':
            return self._send_json(HTTPStatus.OK, {'success': True, 'now': time.time()})

        if path == '/available_video_indices':
            return self._send_json(HTTPStatus.OK, {
                'success': True, 'indices': list_video_indices(),
            })

        # Serve project-root files that the online script.js fetches by relative path.
        if path in ROOT_FILES:
            return self._send_file(ROOT_FILES[path])

        # Leading-slash root files such as /style.css are covered by ROOT_FILES.

        # /local/<file>, including mediarecorder-shim.js.
        if path.startswith('/local/'):
            abs_path = self._safe_join('local', path[len('/local/'):])
            if not abs_path:
                return self.send_error(HTTPStatus.FORBIDDEN, 'Bad path')
            return self._send_file(abs_path)

        # Videos.
        if path.startswith('/videos/') or path.startswith('videos/'):
            abs_path = self._safe_join('videos', path[len('/videos/') if path.startswith('/videos/') else len('videos/'):])
            if not abs_path:
                return self.send_error(HTTPStatus.FORBIDDEN, 'Bad path')
            return self._send_file(abs_path)

        # Posters.
        if path.startswith('/posters/') or path.startswith('posters/'):
            abs_path = self._safe_join('posters', path[len('/posters/') if path.startswith('/posters/') else len('posters/'):])
            if not abs_path:
                return self.send_error(HTTPStatus.FORBIDDEN, 'Bad path')
            return self._send_file(abs_path)

        # Assets such as the consent PDF and example video.
        if path.startswith('/assets/'):
            abs_path = self._safe_join('assets', path[len('/assets/'):])
            if not abs_path:
                return self.send_error(HTTPStatus.FORBIDDEN, 'Bad path')
            return self._send_file(abs_path)

        return self.send_error(HTTPStatus.NOT_FOUND, 'Unknown path: ' + path)

    def do_POST(self):
        url = urlparse(self.path)
        path = url.path
        if path == '/validate_user':
            return self._handle_validate_user()
        if path == '/save_profile':
            return self._handle_save_profile()
        if path == '/upload':
            return self._handle_upload()
        return self.send_error(HTTPStatus.NOT_FOUND, 'Unknown POST: ' + path)

    # ---------- API ----------

    def _read_body(self) -> bytes:
        length = int(self.headers.get('Content-Length', '0'))
        if length <= 0:
            return b''
        if length > 200 * 1024 * 1024:
            raise ValueError('payload too large')
        return self.rfile.read(length)

    def _handle_validate_user(self):
        try:
            body = self._read_body()
            data = json.loads(body.decode('utf-8') or '{}')
        except Exception as e:
            return self._send_json(HTTPStatus.BAD_REQUEST, {'error': '無效 JSON: ' + str(e)})
        full_name = (data.get('fullName') or '').strip()
        contact = (data.get('contact') or '').strip()
        if not full_name or not contact:
            return self._send_json(HTTPStatus.BAD_REQUEST, {'error': '缺少 fullName 或 contact'})

        existing_folder, user_id = find_user_folder(full_name, contact)
        if existing_folder:
            user_dir = os.path.join(RECORDINGS_DIR, existing_folder)
            progress = {}
            try:
                for fn in os.listdir(user_dir):
                    if fn.lower().endswith(('.wav', '.webm')):
                        m = re.match(r'(\d{4}_\d+)_(\w+)\.(wav|webm)$', fn, re.IGNORECASE)
                        if m:
                            base, lang = m.group(1), m.group(2)
                            progress.setdefault(base, {})[lang] = True
            except Exception:
                pass
            return self._send_json(HTTPStatus.OK, {
                'status': 'existing_user',
                'userId': user_id,
                'progress': progress,
            })
        else:
            return self._send_json(HTTPStatus.OK, {'status': 'new_user'})

    def _handle_save_profile(self):
        try:
            body = self._read_body()
            full_profile = json.loads(body.decode('utf-8') or '{}')
        except Exception as e:
            return self._send_json(HTTPStatus.BAD_REQUEST, {'error': '無效 JSON: ' + str(e)})
        if not full_profile or 'userId' not in full_profile:
            return self._send_json(HTTPStatus.BAD_REQUEST, {'error': '無效的資料格式'})
        try:
            user_id = full_profile['userId']
            folder = safe_folder_name(user_id) or 'anonymous'
            user_dir = os.path.join(RECORDINGS_DIR, folder)
            os.makedirs(user_dir, exist_ok=True)
            tmp = os.path.join(user_dir, 'user_profile.json.tmp')
            final = os.path.join(user_dir, 'user_profile.json')
            with open(tmp, 'w', encoding='utf-8') as f:
                json.dump(full_profile, f, ensure_ascii=False, indent=4)
            os.replace(tmp, final)
            self.log_message('SAVED PROFILE %s', final)
            return self._send_json(HTTPStatus.OK, {'success': True})
        except Exception as e:
            self.log_message('save_profile error: %s', e)
            return self._send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {'error': str(e)})

    def _handle_upload(self):
        try:
            body = self._read_body()
        except Exception as e:
            return self._send_json(HTTPStatus.BAD_REQUEST, {'error': str(e)})
        ctype = self.headers.get('Content-Type', '')
        if 'multipart/form-data' not in ctype:
            return self._send_json(HTTPStatus.BAD_REQUEST, {'error': '非 multipart 請求'})
        try:
            fields = parse_multipart(body, ctype)
        except Exception as e:
            return self._send_json(HTTPStatus.BAD_REQUEST, {'error': '解析 multipart 失敗: ' + str(e)})

        audio = fields.get('audio_file')
        meta_str = fields.get('metadata')
        if not audio or not isinstance(audio, tuple) or not meta_str:
            return self._send_json(HTTPStatus.BAD_REQUEST, {'error': '缺少音檔或元數據'})

        try:
            metadata = json.loads(meta_str)
        except Exception:
            return self._send_json(HTTPStatus.BAD_REQUEST, {'error': 'metadata 不是合法 JSON'})

        user_id = metadata.get('userId')
        if not user_id:
            return self._send_json(HTTPStatus.BAD_REQUEST, {'error': '元數據中缺少 userId'})

        original_filename, audio_bytes = audio
        if not audio_bytes:
            return self._send_json(HTTPStatus.BAD_REQUEST, {'error': '空音檔'})

        folder = safe_folder_name(user_id) or 'anonymous'
        user_dir = os.path.join(RECORDINGS_DIR, folder)
        os.makedirs(user_dir, exist_ok=True)

        # Detect the actual payload format from the RIFF/WAVE header.
        is_wav_payload = is_wav(audio_bytes)
        base, _ = os.path.splitext(os.path.basename(original_filename) or 'audio')
        out_ext = '.wav' if is_wav_payload else '.webm'
        out_name = base + out_ext
        out_path = os.path.join(user_dir, out_name)

        try:
            tmp = out_path + '.tmp'
            with open(tmp, 'wb') as f:
                f.write(audio_bytes)
            os.replace(tmp, out_path)

            # Keep a copy in raw/ to match the online layout for later merging.
            if is_wav_payload:
                raw_dir = os.path.join(user_dir, 'raw')
                os.makedirs(raw_dir, exist_ok=True)
                raw_path = os.path.join(raw_dir, out_name)
                with open(raw_path, 'wb') as f:
                    f.write(audio_bytes)
            else:
                raw_path = ''

            metadata['storedFilename'] = out_name
            metadata['storedFormat'] = 'wav' if is_wav_payload else 'webm'
            if raw_path:
                metadata['storedRawFilename'] = os.path.relpath(raw_path, user_dir).replace('\\', '/')
            metadata['savedAt'] = now_iso()
            # Extract audioInfo from the WAV header to avoid an ffprobe dependency.
            metadata['audioInfo'] = wav_audio_info(audio_bytes) if is_wav_payload else None

            meta_name = base + '.json'
            meta_path = os.path.join(user_dir, meta_name)
            tmp_meta = meta_path + '.tmp'
            with open(tmp_meta, 'w', encoding='utf-8') as f:
                json.dump(metadata, f, ensure_ascii=False, indent=4)
            os.replace(tmp_meta, meta_path)

            self.log_message('SAVED %s (%d bytes, %s)',
                             out_path, len(audio_bytes), 'wav' if is_wav_payload else 'webm')
            return self._send_json(HTTPStatus.OK, {
                'success': True,
                'filename': out_name,
                'bytes': len(audio_bytes),
                'format': 'wav' if is_wav_payload else 'webm',
            })
        except Exception as e:
            self.log_message('upload error: %s', e)
            return self._send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {'error': str(e)})


def wav_audio_info(b: bytes) -> dict:
    """Extract sampleRate, channels, and duration from a WAV header without ffprobe."""
    try:
        if len(b) < 44 or b[:4] != b'RIFF' or b[8:12] != b'WAVE':
            return {}
        # fmt chunk @ offset 12 (chunkID 'fmt ')
        if b[12:16] != b'fmt ':
            return {}
        import struct
        fmt_size = struct.unpack_from('<I', b, 16)[0]
        audio_format, num_channels, sample_rate, byte_rate, block_align, bits_per_sample = \
            struct.unpack_from('<HHIIHH', b, 20)
        # Find the data chunk.
        i = 20 + fmt_size
        while i + 8 <= len(b):
            chunk_id = b[i:i+4]
            chunk_size = struct.unpack_from('<I', b, i+4)[0]
            if chunk_id == b'data':
                duration = chunk_size / float(byte_rate) if byte_rate else None
                info = {
                    'codec': 'pcm_s16le' if (audio_format == 1 and bits_per_sample == 16) else None,
                    'sampleRate': sample_rate,
                    'channels': num_channels,
                    'duration': duration,
                }
                return {
                    'normalized': dict(info),
                    'raw': dict(info),
                    'source': dict(info),
                }
            i += 8 + chunk_size
    except Exception:
        pass
    return {}


class ThreadingHTTPServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=5050)
    ap.add_argument('--host', default='127.0.0.1')
    ap.add_argument('--no-browser', action='store_true')
    args = ap.parse_args()

    # Check required files before starting the server.
    needed = [
        os.path.join(REPO_ROOT, 'index.html'),
        os.path.join(REPO_ROOT, 'style.css'),
        os.path.join(REPO_ROOT, 'script.js'),
        PROOF_SOURCE_JSON,
        os.path.join(LOCAL_DIR, 'mediarecorder-shim.js'),
    ]
    missing = [p for p in needed if not os.path.exists(p)]
    if missing:
        print('[錯誤] 缺少必要檔案：')
        for p in missing:
            print('  -', p)
        sys.exit(1)

    os.makedirs(RECORDINGS_DIR, exist_ok=True)

    print('=' * 60)
    print(' TaigiSpeech 離線本機錄音')
    print('=' * 60)
    print(f' 服務位址：http://{args.host}:{args.port}/')
    print(f' 錄音存到：{RECORDINGS_DIR}')
    print(' 按 Ctrl+C 結束')
    print('=' * 60)

    if not args.no_browser:
        try:
            threading.Timer(1.2, lambda: webbrowser.open(f'http://{args.host}:{args.port}/')).start()
        except Exception:
            pass

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print('\n停止中…')
    finally:
        httpd.server_close()


if __name__ == '__main__':
    main()
