#!/usr/bin/env python3
"""Freedom Map prototype server.

Serves the static site and a tiny shared API for the interest chips, so that
a chip one person adds (or marks as not applicable) is visible to everyone
using the same server. Standard library only.

    python3 server.py              # http://localhost:8000
    python3 server.py --port 8080 --host 0.0.0.0   # share on your network

State is kept in data/state/interests.json and data/state/fixes.json (git-ignored).
The fixes API collects readers' approvals of, and alternative wordings for, proposed legal amendments.
"""
import argparse, json, os, re, threading, time, uuid
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

ROOT = os.path.dirname(os.path.abspath(__file__))
STATE_FILE = os.path.join(ROOT, "data", "state", "interests.json")
LOCK = threading.Lock()
KEY_RE = re.compile(r"^[\w\- .,'()/|À-ɏЀ-ӿ]{1,200}$")
FIXES_FILE = os.path.join(ROOT, "data", "state", "fixes.json")
MAX_LABEL = 60
MAX_SUGGESTION = 2000
MAX_SUGGESTIONS = 50
MAX_BODY = 16384


def load_state(path=STATE_FILE):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save_state(state, path=STATE_FILE):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def fix_entry(state, key):
    return state.setdefault(key, {"approvals": 0, "suggestions": []})


def entry(state, key):
    return state.setdefault(key, {"added": [], "hidden": []})


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        # Always revalidate, so a reload shows the latest data and scripts after a git pull.
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    # Never serve the server's own state or git metadata as static files.
    def translate_path(self, path):
        p = urlparse(path).path
        if p.startswith("/data/state") or p.startswith("/.git"):
            return os.path.join(ROOT, "__forbidden__")
        return super().translate_path(path)

    def send_json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/api/interests":
            key = (parse_qs(u.query).get("key") or [""])[0]
            if not KEY_RE.match(key):
                return self.send_json(400, {"error": "bad key"})
            with LOCK:
                e = load_state().get(key, {"added": [], "hidden": []})
            return self.send_json(200, e)
        if u.path == "/api/fixes":
            key = (parse_qs(u.query).get("key") or [""])[0]
            if not KEY_RE.match(key):
                return self.send_json(400, {"error": "bad key"})
            with LOCK:
                e = load_state(FIXES_FILE).get(key, {"approvals": 0, "suggestions": []})
            return self.send_json(200, e)
        return super().do_GET()

    def read_body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0 or n > MAX_BODY:
            return None
        try:
            return json.loads(self.rfile.read(n).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return None

    def do_POST(self):
        u = urlparse(self.path)
        body = self.read_body()
        if not isinstance(body, dict):
            return self.send_json(400, {"error": "bad body"})
        key = str(body.get("key", ""))
        if not KEY_RE.match(key):
            return self.send_json(400, {"error": "bad key"})
        if u.path == "/api/interests":
            label = " ".join(str(body.get("label", "")).split())[:MAX_LABEL]
            if not label:
                return self.send_json(400, {"error": "empty label"})
            with LOCK:
                state = load_state()
                e = entry(state, key)
                if not any(a["label"].lower() == label.lower() for a in e["added"]):
                    e["added"].append({"id": "u:" + uuid.uuid4().hex[:12], "label": label, "at": int(time.time())})
                save_state(state)
            return self.send_json(200, e)
        if u.path == "/api/interests/hide":
            cid = str(body.get("id", ""))[:80]
            if not cid:
                return self.send_json(400, {"error": "missing id"})
            with LOCK:
                state = load_state()
                e = entry(state, key)
                if cid not in e["hidden"]:
                    e["hidden"].append(cid)
                save_state(state)
            return self.send_json(200, e)
        if u.path == "/api/fixes/approve":
            with LOCK:
                state = load_state(FIXES_FILE)
                e = fix_entry(state, key)
                e["approvals"] += 1
                save_state(state, FIXES_FILE)
            return self.send_json(200, e)
        if u.path == "/api/fixes/suggest":
            text = str(body.get("text", "")).strip()[:MAX_SUGGESTION]
            if not text:
                return self.send_json(400, {"error": "empty text"})
            with LOCK:
                state = load_state(FIXES_FILE)
                e = fix_entry(state, key)
                if len(e["suggestions"]) < MAX_SUGGESTIONS and not any(x["text"] == text for x in e["suggestions"]):
                    e["suggestions"].append({"text": text, "at": int(time.time())})
                save_state(state, FIXES_FILE)
            return self.send_json(200, e)
        return self.send_json(404, {"error": "not found"})


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8000)
    a = ap.parse_args()
    srv = ThreadingHTTPServer((a.host, a.port), Handler)
    print(f"Freedom Map on http://{'localhost' if a.host in ('127.0.0.1', '0.0.0.0') else a.host}:{a.port}/  (Ctrl+C to stop)")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
