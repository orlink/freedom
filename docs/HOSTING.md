# Hosting: free.kredor.com

Development and testing happen locally (`.venv/bin/python server.py`, http://localhost:8000). From time to time a version is uploaded for others to see at **https://free.kredor.com/**:

```sh
tools/deploy.sh
```

It sends the git-tracked files only, restarts the service and checks the site. Environment overrides: `FREEDOM_HOST`, `FREEDOM_SSH_KEY`, `FREEDOM_URL`.

## The server (Host4Fun, Windows Server 2022 with IIS)

Shared with kredor.com, speak.kredor.com, glavobolieto.bg, shipwme.com and others; changes there must not disturb them.

| What | Where |
|---|---|
| Python 3.13 (embeddable) with `anthropic` | `C:\freedom\python` |
| The site | `C:\freedom\app` (git-tracked files) |
| API key | `C:\freedom\app\.env` (`ANTHROPIC_API_KEY=…`; readable only by Administrators, SYSTEM and the service; never uploaded) |
| Saved interests, fixes, chat comments | `C:\freedom\app\data\state` (kept across uploads) |
| Service | `freedom` ("Freedom Map"), WinSW, runs `server.py --host 127.0.0.1 --port 8090` as LocalService, automatic start; logs in `C:\freedom\logs` |
| IIS | site "Freedom", bindings http/https `free.kredor.com`; http → https, then ARR reverse proxy to `127.0.0.1:8090` (`C:\freedom\iis\web.config`) |
| Certificate | Let's Encrypt via win-acme, renewed by the existing "win-acme renew" task |
| DNS | CNAME `free` → `kredor.com.` |

ARR's proxy is enabled server-wide, but it only acts for sites with a rewrite rule to it (here only "Freedom"). The IIS configuration before this setup is backed up in `C:\MigrationTools\applicationHost.config.before-freedom-20261110T010250`.

To set or change the API key: over SSH, edit `C:\freedom\app\.env`, then `Restart-Service freedom`.

Readers' comments for the editors (the speech bubble on a requirement page, and the one beside highlighted law text) are saved on the server in `data/state/review.jsonl`, one JSON object per line: who it is from (`owner` or `reader`), the page and its address, the highlighted text, the comment and any chat the reader had about it. Nothing is published and no token is needed. Limits: the usual per-address write limits, 500 comments a day for the whole site (`FREEDOM_COMMENTS_DAILY`), and no more once the file reaches 20 MB. `tools/deploy.sh` never uploads or overwrites `data/state`.

Files removed from git stay on the server until deleted by hand.
