#!/usr/bin/env python3
"""Freedom Map prototype server.

Serves the static site and a tiny shared API for the interest chips, so that
a chip one person adds (or marks as not applicable) is visible to everyone
using the same server. Standard library only.

    python3 server.py              # http://localhost:8000
    python3 server.py --port 8080 --host 0.0.0.0   # share on your network

    python3 server.py --edit       # the owner's local copy: adding, removing and dragging interest chips
                                   # changes the site's own lists in data/interests.json (per country), to commit

State is kept in data/state/interests.json and data/state/fixes.json (git-ignored).
The fixes API collects readers' approvals of, and alternative wordings for, proposed legal amendments.

The chat on each requirement page (/api/chat) talks to Claude through the official
`anthropic` package, which is the one dependency outside the standard library and is
only needed for the chat:

    python3 -m venv .venv && .venv/bin/pip install anthropic
    echo "ANTHROPIC_API_KEY=sk-ant-..." > .env && chmod 600 .env   # read at startup; git-ignored, never served
    .venv/bin/python server.py

Every conversation is saved to data/state/comments.json, so the comments and suggestions
readers make there can be read later even when the chat is not set up.
"""
import argparse, json, os, posixpath, re, threading, time, uuid
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, parse_qs, unquote

ROOT = os.path.dirname(os.path.abspath(__file__))
STATE_FILE = os.path.join(ROOT, "data", "state", "interests.json")
LOCK = threading.Lock()
KEY_RE = re.compile(r"^[\w\- .,'()/|À-ɏЀ-ӿ]{1,200}$")
FIXES_FILE = os.path.join(ROOT, "data", "state", "fixes.json")
SITE_INTERESTS = os.path.join(ROOT, "data", "interests.json")
EDITOR = False  # set by --edit: the site owner's local copy, where interest edits change data/interests.json
MAX_INTERESTS = 40
MAX_LABEL = 60
MAX_SUGGESTION = 2000
MAX_SUGGESTIONS = 50
MAX_BODY = 16384
COMMENTS_FILE = os.path.join(ROOT, "data", "state", "comments.json")
CHAT_MAX_BODY = 200_000
CHAT_MAX_MESSAGE = 4000
CHAT_MAX_TURNS = 40
CHAT_MAX_CONTEXT = 60_000
CHAT_MODEL = "claude-opus-5-5"
CHAT_RATE = (30, 600)  # at most 30 chat turns per 10 minutes from one address
_CHAT_HITS = {}


# What the web server may hand out as files. Everything else in the folder is private.
PUBLIC_FILES = {"index.html", "what-is-freedom.html", "what-is-freedom-plain.html", "docs/data.md"}
PUBLIC_DIRS = {"css", "js", "img", "vendor"}
PUBLIC_EXT = {".html", ".css", ".js", ".json", ".svg", ".png", ".jpg", ".gif", ".webp", ".ico", ".woff2"}


def is_public(rel):
    """Is this path (relative to the site folder, with forward slashes) a file visitors may download?"""
    rel = rel.lower()
    parts = rel.split("/")
    for part in parts:
        # No dot-files, no Windows short names (~), streams (:) or names Windows would quietly rewrite.
        if not part or part.startswith(".") or part[-1] in ". " or any(c in part for c in '~:\\*?"<>|'):
            return False
    if rel in PUBLIC_FILES:
        return True
    if os.path.splitext(parts[-1])[1] not in PUBLIC_EXT:
        return False
    if parts[0] == "data":  # the site's data only: data/*.json and data/jurisdictions/*.json, never data/state
        return rel.endswith(".json") and (len(parts) == 2 or (len(parts) == 3 and parts[1] == "jurisdictions"))
    return len(parts) >= 2 and parts[0] in PUBLIC_DIRS


def load_env(path=os.path.join(ROOT, ".env")):
    """Read KEY=value lines from .env into the environment (the API key lives there, so it survives restarts).
    Variables already set in the environment win."""
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line.startswith("export "):
                    line = line[7:].strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                k, v = k.strip(), v.strip().strip('"').strip("'")
                if k and k not in os.environ:
                    os.environ[k] = v
    except OSError:
        pass


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


def write_site_interests(data):
    """Save data/interests.json in its hand-written layout: one line per list, so git diffs stay small."""
    def block(d, indent):
        pad = " " * indent
        rows = [f'{pad}{json.dumps(k, ensure_ascii=False)}: ' + (block(v, indent + 2) if isinstance(v, dict) else json.dumps(v, ensure_ascii=False))
                for k, v in d.items()]
        return "{\n" + ",\n".join(rows) + "\n" + " " * (indent - 2) + "}"
    tmp = SITE_INTERESTS + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(block(data, 2) + "\n")
    os.replace(tmp, SITE_INTERESTS)


def html_text(path):
    """The readable text of one of the site's own HTML pages (for the chat's background knowledge)."""
    try:
        with open(os.path.join(ROOT, path), encoding="utf-8") as f:
            h = f.read()
    except OSError:
        return ""
    h = re.sub(r"(?is)<(script|style|svg|nav|header|footer)\b.*?</\1>", " ", h)
    h = re.sub(r"(?i)</(p|h[1-6]|li|blockquote)>", "\n", h)
    h = re.sub(r"<[^>]+>", " ", h)
    return "\n".join(" ".join(l.split()) for l in h.splitlines() if l.strip())


def chat_system():
    """The chat's standing instructions: what the site is, its principles and its scoring.
    It changes only when the site's text does, so it is sent as a cached prefix."""
    try:
        with open(os.path.join(ROOT, "data", "catalog.json"), encoding="utf-8") as f:
            cat = json.load(f)
    except (OSError, ValueError):
        cat = {}
    props = "\n".join(f"- {v.get('name')}: {v.get('longName', '')}. {v.get('description', '')}".strip()
                       for v in (cat.get("properties") or {}).values())
    mechs = "\n".join(f"- {v.get('name')}: {v.get('description', '')}" for v in (cat.get("mechanisms") or {}).values())
    return f"""You are the assistant on Freedom Map, a website that shows, for any place, how free its people are to govern their own common interests at every level, from the home and the apartment building up to the municipality, the country and the union. You talk with a reader on one requirement page. That page shows whether one requirement of one decision making institution (for example "No participation quorum requirement" for local referendums in Bulgaria) is met, partly met or not met, quotes the articles of law it rests on, and may offer a Fix: amendments the site proposes.

The site's own account of freedom (the page "What is freedom"):
{html_text("what-is-freedom.html")}

How the map judges institutions:
- A level is as free as its best way of deciding: direct (referendums, general assemblies) or representative (councils, executives, representatives elected to a higher-level council).
- Each institution is scored from its requirements: met = 1, partly met = 0.5, not met = 0. Some requirements are gates: if an institution does not exist in law, is not binding, or has a participation quorum, it scores as ineffective whatever else is true.
- Colours run from teal (free) to dark red (not free).
- Agenda initiatives are deliberately left off the map: no one accountable makes the proposal.

Decision making institutions in the catalogue:
{mechs}

Requirements in the catalogue:
{props}

How to help the reader:
- Answer questions about this requirement, the law quoted on the page, the verdict and the proposed fix, competently and plainly, as a knowledgeable colleague would. Ground what you say in the page's text and in the law; say so when you are not sure, and do not invent articles, numbers or court cases.
- Readers may disagree with the verdict, point out an error, or suggest a different wording of a fix. Take that seriously: weigh it against the law and the site's principles, say whether you think they are right and why, and help them sharpen the suggestion. Their messages are saved for the site's editors, who decide what changes; you cannot change the site yourself, so never say that you have.
- Write in the reader's language (often Bulgarian or English). Keep replies short, a few sentences or a short list, unless the reader asks for more. No headings.
"""


_CHAT_SYSTEM = None
_CLIENT = None


def chat_reply(context, messages):
    """Ask Claude for the next reply. Returns (text, error)."""
    global _CHAT_SYSTEM, _CLIENT
    try:
        import anthropic
    except ImportError:
        return None, "The chat is not set up on this server yet: install the anthropic package (pip install anthropic)."
    if _CHAT_SYSTEM is None:
        _CHAT_SYSTEM = chat_system()
    try:
        if _CLIENT is None:
            _CLIENT = anthropic.Anthropic()
        r = _CLIENT.beta.messages.create(
            model=CHAT_MODEL,
            max_tokens=16000,
            output_config={"effort": "medium"},
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            system=[
                {"type": "text", "text": _CHAT_SYSTEM, "cache_control": {"type": "ephemeral"}},
                {"type": "text", "text": "The page the reader is on:\n\n" + context},
            ],
            messages=messages,
        )
    except anthropic.AuthenticationError:
        return None, "The chat is not set up on this server yet: set ANTHROPIC_API_KEY (or sign in with `ant auth login`)."
    except anthropic.RateLimitError:
        return None, "The chat is busy right now. Please try again in a minute."
    except anthropic.APIStatusError as e:
        return None, f"The chat could not answer (error {e.status_code}). Please try again."
    except anthropic.APIConnectionError:
        return None, "The chat could not reach Claude. Please check the server's internet connection."
    except Exception as e:  # e.g. no credentials configured at all
        return None, f"The chat is not set up on this server yet ({type(e).__name__})."
    if r.stop_reason == "refusal":
        return None, "Claude declined to answer this message."
    text = "".join(b.text for b in r.content if b.type == "text").strip()
    return text or None, (None if text else "The chat returned an empty answer. Please try again.")


def chat_allowed(ip):
    now = time.time()
    with LOCK:
        hits = [t for t in _CHAT_HITS.get(ip, []) if now - t < CHAT_RATE[1]]
        ok = len(hits) < CHAT_RATE[0]
        if ok:
            hits.append(now)
        _CHAT_HITS[ip] = hits
    return ok


def save_comment(key, cid, messages, context_title):
    with LOCK:
        state = load_state(COMMENTS_FILE)
        convs = state.setdefault(key, {"title": context_title, "conversations": {}})["conversations"]
        # "user" stays empty until readers sign in (planned); then it records who wrote the comment.
        convs[cid] = {"at": int(time.time()), "user": None, "messages": messages}
        save_state(state, COMMENTS_FILE)


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        # Always revalidate, so a reload shows the latest data and scripts after a git pull.
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    # Static files are served from an allow-list (PUBLIC_*), never by excluding what is private: the key file
    # (.env), the saved state (data/state), the server's own code and the deploy tools are simply not on it.
    # The address is checked twice: as asked for (decoded), and as the file it really resolves to on disk, so
    # that other spellings of a private file cannot slip through (Windows: "ENV~1" is .env, "Data/State" is
    # data/state, a trailing dot or space is ignored; anywhere: "%2eenv", symbolic links).
    def translate_path(self, path):
        forbidden = os.path.join(ROOT, "__forbidden__")
        p = posixpath.normpath(unquote(urlparse(path).path)).strip("/")
        if p in ("", "."):
            p = "index.html"
        if not is_public(p):
            return forbidden
        root = os.path.realpath(ROOT)
        real = os.path.realpath(os.path.join(root, *p.split("/")))
        try:
            rel = os.path.relpath(real, root)
        except ValueError:  # another drive
            return forbidden
        if not is_public(rel.replace(os.sep, "/")) or not os.path.isfile(real):
            return forbidden
        return real

    def list_directory(self, path):
        self.send_error(404, "File not found")
        return None

    def send_json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def is_editor(self):
        """Editing the site's own interest lists: only with --edit, and only from this computer (not through a proxy)."""
        return EDITOR and self.client_address[0] in ("127.0.0.1", "::1") and not self.headers.get("X-Forwarded-For")

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/api/editor":
            return self.send_json(200, {"editor": self.is_editor()})
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

    def read_body(self, limit=MAX_BODY):
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0 or n > limit:
            return None
        try:
            return json.loads(self.rfile.read(n).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return None

    def do_POST(self):
        u = urlparse(self.path)
        if u.path == "/api/chat":
            return self.chat()
        if u.path == "/api/site-interests":
            return self.site_interests()
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

    def site_interests(self):
        """Editor mode: replace one country's list of interests for one level in data/interests.json (order kept)."""
        if not self.is_editor():
            return self.send_json(403, {"error": "editing is only possible on the owner's local copy (server.py --edit)"})
        body = self.read_body()
        if not isinstance(body, dict):
            return self.send_json(400, {"error": "bad body"})
        cc, level, labels = str(body.get("country", "")), str(body.get("level", "")), body.get("labels")
        if not re.match(r"^[a-z]{2}$", cc) or not re.match(r"^[a-z_]{1,40}$", level) or not isinstance(labels, list):
            return self.send_json(400, {"error": "bad country, level or labels"})
        clean = []
        for x in labels[:MAX_INTERESTS]:
            t = " ".join(str(x).split())[:MAX_LABEL]
            if t and t.lower() not in (c.lower() for c in clean):
                clean.append(t)
        with LOCK:
            data = load_state(SITE_INTERESTS)
            if not data:
                return self.send_json(500, {"error": "data/interests.json is missing or unreadable"})
            data.setdefault("countries", {}).setdefault(cc, {})[level] = clean
            write_site_interests(data)
        return self.send_json(200, {"labels": clean})

    def chat(self):
        """One turn of the requirement-page chat: save the conversation, ask Claude, save the reply."""
        body = self.read_body(CHAT_MAX_BODY)
        if not isinstance(body, dict):
            return self.send_json(400, {"error": "bad body"})
        key, cid = str(body.get("key", "")), str(body.get("id", ""))
        if not KEY_RE.match(key) or not re.match(r"^[\w-]{8,64}$", cid):
            return self.send_json(400, {"error": "bad key"})
        context = str(body.get("context", ""))[:CHAT_MAX_CONTEXT]
        msgs = []
        for m in (body.get("messages") or [])[-CHAT_MAX_TURNS:]:
            role, text = (m or {}).get("role"), str((m or {}).get("content", "")).strip()[:CHAT_MAX_MESSAGE]
            if role in ("user", "assistant") and text:
                msgs.append({"role": role, "content": text})
        while msgs and msgs[0]["role"] != "user":
            msgs.pop(0)
        if not msgs or msgs[-1]["role"] != "user":
            return self.send_json(400, {"error": "the last message must be the reader's"})
        title = context.splitlines()[0][:200] if context else key
        save_comment(key, cid, msgs, title)
        ip = self.client_address[0]
        if ip in ("127.0.0.1", "::1") and self.headers.get("X-Forwarded-For"):
            ip = self.headers["X-Forwarded-For"].split(",")[-1].strip()  # behind a local reverse proxy: the visitor's address
            if ip.count(":") == 1:
                ip = ip.split(":")[0]  # IIS ARR appends the port to an IPv4 address
        if not chat_allowed(ip):
            return self.send_json(200, {"reply": None, "error": "Too many messages in a short time. Your message is saved; please wait a few minutes before asking more."})
        text, err = chat_reply(context, msgs)
        if text:
            save_comment(key, cid, msgs + [{"role": "assistant", "content": text}], title)
        return self.send_json(200, {"reply": text, "error": err})


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--edit", action="store_true", help="owner's local copy: interest edits made in the browser change data/interests.json")
    a = ap.parse_args()
    global EDITOR
    EDITOR = a.edit
    load_env()
    srv = ThreadingHTTPServer((a.host, a.port), Handler)
    print(f"Freedom Map on http://{'localhost' if a.host in ('127.0.0.1', '0.0.0.0') else a.host}:{a.port}/  (Ctrl+C to stop)")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
