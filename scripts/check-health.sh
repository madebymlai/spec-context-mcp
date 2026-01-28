#!/usr/bin/env bash
set -euo pipefail

PROJECT_PATH="${1:-$(pwd)}"

PORT=$(python3 - "$PROJECT_PATH" <<'PY'
import hashlib, sys
path = sys.argv[1]
md5 = hashlib.md5(path.encode()).hexdigest()
port = 31000 + (int(md5[:8], 16) % 1000)
print(port)
PY
)

echo "Project: $PROJECT_PATH"
echo "Port: $PORT"

URL="http://127.0.0.1:${PORT}/health"

if command -v curl >/dev/null 2>&1; then
  curl -sS "$URL" || {
    echo "Failed to reach $URL" >&2
    exit 1
  }
else
  python3 - "$URL" <<'PY'
import sys
import urllib.request
url = sys.argv[1]
try:
    with urllib.request.urlopen(url, timeout=2) as resp:
        print(resp.read().decode('utf-8'))
except Exception as e:
    print(f"Failed to reach {url}: {e}", file=sys.stderr)
    raise SystemExit(1)
PY

fi
