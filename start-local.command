#!/bin/bash
# TaigiSpeech local recording launcher for macOS.
# Double-click this file to start the fully local app. No network is required.
# If double-clicking fails, right-click the file in Finder and choose Open for first-run approval.

cd "$(dirname "$0")" || exit 1

export PYTHONIOENCODING=utf-8
export PYTHONUTF8=1

PY=""
if command -v python3 >/dev/null 2>&1; then
    PY="python3"
elif command -v python >/dev/null 2>&1; then
    # Confirm this is Python 3.
    PYV=$(python -c "import sys;print(sys.version_info[0])" 2>/dev/null)
    if [ "$PYV" = "3" ]; then
        PY="python"
    fi
fi

if [ -z "$PY" ]; then
    echo "[錯誤] 找不到 Python 3。"
    echo
    echo "請執行以下其一安裝 Python 3："
    echo "  1. 到 https://www.python.org/downloads/ 下載官方安裝包"
    echo "  2. 或執行：xcode-select --install 然後 /usr/bin/python3"
    echo "  3. 若有 Homebrew：brew install python3"
    echo
    read -n 1 -s -r -p "按任意鍵關閉…"
    exit 1
fi

echo "使用 Python：$($PY --version 2>&1)"
"$PY" local_server.py "$@"

# Keep the window open after the server exits so logs remain visible.
echo
read -n 1 -s -r -p "本機 server 已停止。按任意鍵關閉…"
