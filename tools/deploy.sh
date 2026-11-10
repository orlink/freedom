#!/bin/zsh
# Upload the current version of the Freedom Map to https://free.kredor.com/ (the Host4Fun Windows server).
#
#   tools/deploy.sh            # from the repo root, after testing locally
#
# Sends only the git-tracked site files. The server's own .env (the API key) and data/state (saved interests,
# fixes and chat comments) are never touched. Then restarts the "freedom" Windows service and checks the site.
# Server setup (Python in C:\freedom\python, service "freedom" on 127.0.0.1:8090, IIS site "Freedom" with ARR
# and a win-acme certificate) is described in docs/HOSTING.md.
set -euo pipefail

HOST=${FREEDOM_HOST:-Administrator@38.86.91.8}
KEY=${FREEDOM_SSH_KEY:-$HOME/codex_migrate_nopass_key}
URL=${FREEDOM_URL:-https://free.kredor.com/}
SSH_OPTS=(-i "$KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15 -o LogLevel=ERROR)

cd "$(git rev-parse --show-toplevel)"
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Warning: uncommitted changes. Uploading the files as they are on disk:" >&2
  git status --short >&2
fi

files=( ${(f)"$(git ls-files | grep -v -E '^(\.env|\.venv/|data/state/)')"} )
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
COPYFILE_DISABLE=1 tar --no-xattrs -cf "$tmp/site.tar" "${files[@]}"
echo "Uploading ${#files} files ($(git rev-parse --short HEAD))…"
scp -q "${SSH_OPTS[@]}" "$tmp/site.tar" "$HOST:C:/MigrationTools/freedom-site.tar"

# Extract over C:\freedom\app, restart the service and wait until it answers locally.
ps='$ErrorActionPreference = "Stop"; $ProgressPreference = "SilentlyContinue"
tar -xf C:\MigrationTools\freedom-site.tar -C C:\freedom\app
Remove-Item C:\MigrationTools\freedom-site.tar
Restart-Service freedom
foreach ($i in 1..20) {
  try { if ((Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://127.0.0.1:8090/).StatusCode -eq 200) { "service up"; exit 0 } } catch {}
  Start-Sleep -Milliseconds 500
}
"service did not answer on 127.0.0.1:8090; see C:\freedom\logs"; exit 1'
enc=$(print -rn -- "$ps" | iconv -t UTF-16LE | base64 | tr -d '\n')
ssh "${SSH_OPTS[@]}" "$HOST" "powershell -NoProfile -NonInteractive -EncodedCommand $enc"

code=$(curl -s -o /dev/null -w '%{http_code}' "$URL" || true)
if [[ "$code" != 200 ]]; then
  # The Mac may still cache an old DNS answer for the name: ask the server directly.
  name=${${URL#https://}%%/*}
  code=$(curl -s -o /dev/null -w '%{http_code}' --resolve "$name:443:${HOST#*@}" "$URL" || true)
fi
if [[ "$code" == 200 ]]; then echo "Live: $URL"; else echo "Uploaded, but $URL returned $code" >&2; exit 1; fi
