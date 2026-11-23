#!/usr/bin/env python3
"""Freedom Map prototype server.

Serves the static site and a tiny shared API for the interest chips, so that
a chip one person adds (or marks as not applicable) is visible to everyone
using the same server. Standard library only.

    python3 server.py              # http://localhost:8000
    python3 server.py --port 8080 --host 0.0.0.0   # share on your network

    python3 server.py --edit       # the owner's local copy: adding, removing and dragging interest chips
                                   # changes the site's own lists in data/interests.json (per country), to commit

    python3 server.py --edit       # also shows a comment icon beside every paragraph; a comment is appended,
                                   # with the paragraph and where it is, to data/state/review.jsonl for Claude to answer

State is kept in data/state/interests.json and data/state/fixes.json (git-ignored).
The fixes API collects readers' approvals of, and alternative wordings for, proposed legal amendments.

The chat on each requirement page (/api/chat) talks to Claude through the official
`anthropic` package, which is the one dependency outside the standard library and is
only needed for the chat:

    python3 -m venv .venv && .venv/bin/pip install anthropic
    echo "ANTHROPIC_API_KEY=sk-ant-..." > .env && chmod 600 .env   # read at startup; git-ignored, never served
    .venv/bin/python server.py

Every conversation is saved to data/state/comments.json, so the comments and suggestions
readers make there can be read later even when the chat is not set up. Readers' comments for the editors
(/api/comment), on a whole requirement or on highlighted law text, are saved to data/state/review.jsonl (docs/HOSTING.md).
With FREEDOM_EDITOR_KEY in .env, an editor (or an editor's Claude, through tools/comments.py) can list that queue and
record a status and a reply for each comment (/api/comments).

Readers sign in with an emailed code, Google or Apple (accounts.py, /api/auth/…, /api/me), each only where .env sets
it up. On a server that has accounts, a comment needs a signed-in reader.
"""
import argparse, hashlib, hmac, json, os, posixpath, re, secrets, sys, threading, time, uuid
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, parse_qs, unquote, quote

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # the server's embeddable Python does not look beside the script
import accounts

ROOT = os.path.dirname(os.path.abspath(__file__))
STATE_FILE = os.path.join(ROOT, "data", "state", "interests.json")
LOCK = threading.Lock()
KEY_RE = re.compile(r"^[\w\- .,'()/|À-ɏЀ-ӿ]{1,200}$")
FIXES_FILE = os.path.join(ROOT, "data", "state", "fixes.json")
SITE_INTERESTS = os.path.join(ROOT, "data", "interests.json")
EDITOR = False  # set by --edit: the site owner's local copy, where interest edits change data/interests.json
REVIEW_FILE = os.path.join(ROOT, "data", "state", "review.jsonl")  # the editors' queue: the owner's and readers' comments
MAX_REVIEW_TEXT = 8000
MAX_INTERESTS = 40
MAX_LABEL = 60
MAX_SUGGESTION = 2000
MAX_SUGGESTIONS = 50
MAX_BODY = 16384
COMMENTS_FILE = os.path.join(ROOT, "data", "state", "comments.json")
AUDIT_FILE = os.path.join(ROOT, "data", "state", "audit.jsonl")  # who changed what (hashed address), to undo by hand
SALT_FILE = os.path.join(ROOT, "data", "state", "salt.txt")
CHAT_MAX_BODY = 64_000
CHAT_MAX_MESSAGE = 2000
CHAT_MAX_TURNS = 20         # messages kept from one conversation (10 questions and answers)
CHAT_MAX_CONTEXT = 12_000   # the page text the browser sends; the longest real page is about 6,000 characters
CHAT_MAX_TOKENS = 1500      # a reply of a few paragraphs at most
CHAT_MODEL = "claude-opus-5-5"

# Limits on the public endpoints. Each is (count, seconds): at most that many requests in that time.
# Counters live in memory, so a restart resets them. FREEDOM_CHAT_DAILY overrides the site-wide chat ceiling.
CHAT_LIMITS = [(20, 600), (100, 86400)]                                   # per address
CHAT_DAILY_TOTAL = int(os.environ.get("FREEDOM_CHAT_DAILY") or 500)        # whole site, per day
WRITE_LIMITS = [(30, 600), (300, 86400)]                                  # per address: interests, hides, approvals, suggestions
MAX_STATE_BYTES = 5_000_000      # interests.json, fixes.json: no more writes once a file is this large
MAX_COMMENTS_BYTES = 20_000_000  # comments.json
MAX_AUDIT_BYTES = 20_000_000
MAX_CONVERSATIONS = 200          # per requirement page


# Readers' comments for the editors (/api/comment), on a whole requirement or on highlighted law text, are saved on this
# server in REVIEW_FILE, the queue the owner's own paragraph comments go to as well. Nothing is published and nothing
# leaves the server (Orlin 2026-11-22; they used to become GitHub issues).
COMMENTS_DAILY = 500           # readers' comments per day, whole site (FREEDOM_COMMENTS_DAILY overrides)
COMMENT_RATE = None            # made in main(), after .env is read
MAX_REVIEW_BYTES = 20_000_000  # no more readers' comments once the queue is this large

# The editors' door into that queue: GET /api/comments lists it, POST /api/comments/update records what an editor did
# with a comment (a status and a reply for its author). Open only to a request that carries the editor key from this
# server's .env (FREEDOM_EDITOR_KEY, at least 32 characters, in the "Authorization: Bearer" header, never in an
# address), and to the owner's local copy (--edit). Without a key in .env it is closed. The queue itself is only ever
# appended to; statuses and replies live beside it in REVIEW_STATE_FILE.
REVIEW_STATE_FILE = os.path.join(ROOT, "data", "state", "review-state.json")
COMMENT_STATUSES = ("new", "answered", "applied", "declined", "hidden")

# Readers see comments too (GET /api/page-comments?key=<page>): only signed-in readers, and only comments sent by a
# signed-in reader under the notice that says so (the record's "public"); earlier comments were sent as private and
# stay with the editors. Shown are the comment, the passage it is about, its author's name, its status and the
# editors' reply; never the chat, the address or the editors' note. COMMENTS_SHOWN says which ones others see:
#   "all"      every such comment at once, except those an editor has set to "hidden" (Claude's choice while Orlin's
#              answer is pending, 2026-11-23)
#   "handled"  only once an editor has answered, applied or declined it
#   "own"      nobody else's
# The author always sees their own, whatever its status.
COMMENTS_SHOWN = "all"
MAX_PAGE_COMMENTS = 200
MAX_NAME = 60
MAX_REPLY = 4000
MAX_LISTED = 500               # comments in one answer
KEY_FAIL_LIMITS = [(10, 600)]  # wrong keys from one address before its wrong keys are no longer even looked at
MAX_COMMENT = 2000

# Accounts (accounts.py). The reader's sign-in is a random token in the cookie SESSION_COOKIE: not readable by the
# page's scripts, sent only to this site and, except on a local copy, only over https. FLOW_COOKIE lives for the ten
# minutes of a trip to Google or Apple and back. SIGNIN_NOTE tells the page that such a trip failed.
SESSION_COOKIE, FLOW_COOKIE, SIGNIN_NOTE = "fm_session", "fm_flow", "fm_signin"
MAIL_LIMITS = [(5, 600), (20, 86400)]         # sign-in codes asked for from one address
MAIL_TO_LIMITS = [(3, 600), (8, 86400)]       # sign-in codes sent to one email address
MAIL_DAILY = 300                              # sign-in codes per day, whole site (FREEDOM_MAIL_DAILY overrides)
SIGNIN_LIMITS = [(30, 600), (200, 86400)]     # per address: codes tried, trips to Google or Apple started
MAIL_TOTAL = None                             # made in main(), after .env is read

# What the web server may hand out as files. Everything else in the folder is private.
PAGES = {"index.html", "what-is-freedom.html", "what-is-freedom-plain.html"}  # served without ".html" (clean_path)
PUBLIC_FILES = PAGES | {"docs/data.md"}
PUBLIC_DIRS = {"css", "js", "img", "vendor"}
PUBLIC_EXT = {".html", ".css", ".js", ".json", ".svg", ".png", ".jpg", ".gif", ".webp", ".ico", ".woff2"}

# Language versions have their own address: /bg/… is the Bulgarian site (English is at the root). The prefix is taken
# off before anything else, so every language uses the same files and API; the page itself gets its language's
# title and link-preview tags here, since previews (WhatsApp, Facebook) do not run the page's scripts.
PAGE_LANGS = {
    "bg": {
        "html_lang": "bg",
        "title": "Карта на свободата",
        "description": "Колко свободни са хората на всяко ниво на общността, от отделния човек до съюза, да управляват своите общи интереси?",
        "url": "https://free.kredor.com/bg/",
        "locale": "bg_BG",
        "locale_alt": "en_GB",
        "image_alt": "Логото на Картата на свободата",
    },
}


def localized_page(html, code):
    """index.html for a language version: its lang attribute, title, description, canonical address and preview tags."""
    m = PAGE_LANGS[code]
    def attr(pattern, value):
        nonlocal html
        html = re.sub(pattern, lambda mo: mo.group(1) + value.replace("&", "&amp;").replace('"', "&quot;") + mo.group(2), html, count=1)
    attr(r'(<html lang=")[^"]*(")', m["html_lang"])
    html = re.sub(r"<title>[^<]*</title>", f"<title>{m['title']}</title>", html, count=1)
    attr(r'(<meta name="description" content=")[^"]*(")', m["description"])
    attr(r'(<meta property="og:site_name" content=")[^"]*(")', m["title"])
    attr(r'(<meta property="og:title" content=")[^"]*(")', m["title"])
    attr(r'(<meta property="og:description" content=")[^"]*(")', m["description"])
    attr(r'(<meta property="og:url" content=")[^"]*(")', m["url"])
    attr(r'(<link rel="canonical" href=")[^"]*(")', m["url"])
    attr(r'(<meta property="og:locale" content=")[^"]*(")', m["locale"])
    attr(r'(<meta property="og:locale:alternate" content=")[^"]*(")', m["locale_alt"])
    attr(r'(<meta property="og:image:alt" content=")[^"]*(")', m["image_alt"])
    return html


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


def read_queue():
    """The comments in REVIEW_FILE, oldest first (call it holding LOCK). Lines that are not a comment are skipped."""
    out = []
    try:
        with open(REVIEW_FILE, encoding="utf-8") as f:
            for line in f:
                try:
                    rec = json.loads(line)
                except ValueError:
                    continue
                if isinstance(rec, dict) and isinstance(rec.get("id"), str):
                    out.append(rec)
    except OSError:
        pass
    return out


_page_cache = {"sig": None, "pages": {}}


def page_comments(key):
    """The public comments about one page, oldest first (call it holding LOCK). The queue is read again only when
    the file has changed."""
    try:
        st = os.stat(REVIEW_FILE)
        sig = (st.st_mtime_ns, st.st_size)
    except OSError:
        return []
    if _page_cache["sig"] != sig:
        pages = {}
        for rec in read_queue():
            if rec.get("public") is True and rec.get("user") and isinstance(rec.get("key"), str):
                pages.setdefault(rec["key"], []).append(
                    {k: rec.get(k, "") for k in ("id", "at", "kind", "text", "where", "comment", "user")})
        _page_cache.update(sig=sig, pages=pages)
    return _page_cache["pages"].get(key, [])


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
- Each institution is scored from its requirements: met = 1, partly met = 0.5, not met = 0. Some requirements are gates: if an institution does not exist in law, is not binding, or has a turnout quorum, it scores as ineffective whatever else is true.
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
- Stay on the site's subject: this requirement, the law behind it, the proposed fix, and freedom and self-government as the site understands them. Politely decline anything else (writing unrelated text or code, general questions, tasks for other purposes), in one sentence, and invite a question about the page instead.
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
            max_tokens=CHAT_MAX_TOKENS,
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


class RateLimit:
    """Counts requests per name (an address, or "all") in sliding windows. allow() records the request if it fits."""

    def __init__(self, limits):
        self.limits, self.hits, self.lock, self.swept = limits, {}, threading.Lock(), 0

    def allow(self, name):
        now, longest = time.time(), max(s for _, s in self.limits)
        with self.lock:
            if now - self.swept > 3600:  # forget addresses not seen for a day, so memory stays small
                self.hits = {k: v for k, v in self.hits.items() if v and now - v[-1] < longest}
                self.swept = now
            hits = [t for t in self.hits.get(name, []) if now - t < longest]
            ok = all(sum(1 for t in hits if now - t < secs) < n for n, secs in self.limits)
            if ok:
                hits.append(now)
            self.hits[name] = hits
        return ok


CHAT_RATE = RateLimit(CHAT_LIMITS)
CHAT_TOTAL = RateLimit([(CHAT_DAILY_TOTAL, 86400)])
WRITE_RATE = RateLimit(WRITE_LIMITS)
KEY_FAILS = RateLimit(KEY_FAIL_LIMITS)
MAIL_RATE, MAIL_TO_RATE, SIGNIN_RATE = RateLimit(MAIL_LIMITS), RateLimit(MAIL_TO_LIMITS), RateLimit(SIGNIN_LIMITS)
_SALT = None


def visitor_id(ip):
    """A short one-way hash of the visitor's address: enough to count one approval per visitor and to undo a
    visitor's changes, without storing the address itself. The salt is random and stays on the server."""
    global _SALT
    if _SALT is None:
        try:
            with open(SALT_FILE, encoding="utf-8") as f:
                _SALT = f.read().strip()
        except OSError:
            _SALT = ""
        if not _SALT:
            _SALT = secrets.token_hex(16)
            os.makedirs(os.path.dirname(SALT_FILE), exist_ok=True)
            with open(SALT_FILE, "w", encoding="utf-8") as f:
                f.write(_SALT)
    return hashlib.sha256((_SALT + ip).encode("utf-8")).hexdigest()[:16]


def too_big(path, limit):
    try:
        return os.path.getsize(path) >= limit
    except OSError:
        return False


def audit(ip, action, key, detail=""):
    """Append one line per public change to data/state/audit.jsonl (called under LOCK)."""
    if too_big(AUDIT_FILE, MAX_AUDIT_BYTES):
        return
    os.makedirs(os.path.dirname(AUDIT_FILE), exist_ok=True)
    with open(AUDIT_FILE, "a", encoding="utf-8") as f:
        f.write(json.dumps({"at": int(time.time()), "who": visitor_id(ip), "action": action, "key": key, "detail": detail},
                           ensure_ascii=False) + "\n")


def public_fix(e):
    """A fix's feedback as readers see it: without the list of who approved."""
    return {k: v for k, v in e.items() if k != "approvers"}


def save_comment(key, cid, messages, context_title):
    with LOCK:
        if too_big(COMMENTS_FILE, MAX_COMMENTS_BYTES):
            return False
        state = load_state(COMMENTS_FILE)
        convs = state.setdefault(key, {"title": context_title, "conversations": {}})["conversations"]
        if cid not in convs and len(convs) >= MAX_CONVERSATIONS:
            return False
        # "user" stays empty until readers sign in (planned); then it records who wrote the comment.
        convs[cid] = {"at": int(time.time()), "user": None, "messages": messages}
        save_state(state, COMMENTS_FILE)
    return True


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

    def send_json(self, code, obj, cookies=()):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for c in cookies:
            self.send_header("Set-Cookie", c)
        self.end_headers()
        self.wfile.write(body)

    def go(self, where, cookies=()):
        """Send the browser on to another address (with GET, whatever this request was)."""
        self.send_response(303)
        self.send_header("Location", where)
        self.send_header("Content-Length", "0")
        self.send_header("Cache-Control", "no-store")
        for c in cookies:
            self.send_header("Set-Cookie", c)
        self.end_headers()

    def direct_local(self):
        """Asked for on this computer itself, not through the web server in front (IIS)."""
        return self.client_address[0] in ("127.0.0.1", "::1") and not self.headers.get("X-Forwarded-For")

    def cookie(self, name):
        for part in (self.headers.get("Cookie") or "").split(";"):
            k, _, v = part.strip().partition("=")
            if k == name:
                return v
        return ""

    def make_cookie(self, name, value, seconds, script=False):
        """A Set-Cookie value. seconds=0 removes the cookie. script: readable by the page's scripts (a note only)."""
        secure = "" if self.direct_local() else "; Secure"
        return f"{name}={value}; Path=/; Max-Age={seconds}; SameSite=Lax{'' if script else '; HttpOnly'}{secure}"

    def user(self):
        """The signed-in reader, or None."""
        return accounts.session_user(self.cookie(SESSION_COOKIE))

    def own_address(self):
        """This site's address as Google and Apple must send the reader back to it."""
        host = self.headers.get("Host") or ""
        if self.direct_local() and re.match(r"^(localhost|127\.0\.0\.1)(:\d{1,5})?$", host):
            return f"http://{host}"
        return accounts.site_url()

    def json_post(self):
        """Is this a request the site's own page made (JSON)? A form on another site cannot send one."""
        return (self.headers.get("Content-Type") or "").lower().startswith("application/json")

    def client_ip(self):
        """The visitor's address. Behind the local reverse proxy (IIS ARR) it is the last X-Forwarded-For entry."""
        ip = self.client_address[0]
        if ip in ("127.0.0.1", "::1") and self.headers.get("X-Forwarded-For"):
            ip = self.headers["X-Forwarded-For"].split(",")[-1].strip()
            if ip.count(":") == 1:
                ip = ip.split(":")[0]  # IIS ARR appends the port to an IPv4 address
        return ip

    def is_editor(self):
        """The owner's tools (editing interest lists, commenting on text): only with --edit, and only from this computer (not through a proxy)."""
        return EDITOR and self.client_address[0] in ("127.0.0.1", "::1") and not self.headers.get("X-Forwarded-For")

    def editor_access(self):
        """May this request read and answer the comment queue? Answers None when it may; otherwise the refusal
        (status, message). The owner's local copy may; anyone else needs the editor key from this server's .env."""
        if self.is_editor():
            return None
        key = os.environ.get("FREEDOM_EDITOR_KEY", "")
        if len(key) < 32:
            return 404, "not found"
        given = self.headers.get("Authorization", "")
        given = given[7:].strip() if given[:7].lower() == "bearer " else ""
        if given and hmac.compare_digest(given.encode("utf-8"), key.encode("utf-8")):
            return None
        if not KEY_FAILS.allow(self.client_ip()):   # the right key still gets in: it cannot be guessed, only known
            return 429, "Too many wrong keys. Try again later."
        return 401, "editor key required"

    lang = "en"

    def take_lang(self):
        """Take a language prefix (/bg/…) off the request's path and note the language. Answers with a redirect,
        and returns False, for /bg without its slash and for old links with ?lang=bg."""
        u = urlparse(self.path)
        query = f"?{u.query}" if u.query else ""
        for code in PAGE_LANGS:
            if u.path == f"/{code}":
                return self.redirect(f"/{code}/{query}")
            if u.path.startswith(f"/{code}/"):
                self.lang = code
                self.path = u.path[len(code) + 1:] + query
                return True
        code = (parse_qs(u.query).get("lang") or [""])[0]
        if code in PAGE_LANGS and u.path in ("/", "/index.html"):
            return self.redirect(f"/{code}/")
        return True

    def clean_path(self):
        """Page addresses without ".html" (Orlin): /what-is-freedom serves what-is-freedom.html, and the old
        /what-is-freedom.html (or /index.html) answers with a permanent redirect to the short address.
        Returns False when it answered with a redirect."""
        u = urlparse(self.path)
        query = f"?{u.query}" if u.query else ""
        prefix = "" if self.lang == "en" else f"/{self.lang}"
        name = u.path.lstrip("/")
        if name in PAGES:
            short = "" if name == "index.html" else name[:-len(".html")]
            return self.redirect(f"{prefix}/{short}{query}", 301)
        if f"{name}.html" in PAGES and name != "index":
            self.path = f"/{name}.html{query}"
        return True

    def redirect(self, location, status=302):
        self.send_response(status)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.end_headers()
        return False

    def send_page(self, code, head_only=False):
        """The start page in another language (see PAGE_LANGS)."""
        try:
            with open(os.path.join(ROOT, "index.html"), encoding="utf-8") as f:
                body = localized_page(f.read(), code).encode("utf-8")
        except OSError:
            return self.send_error(404, "File not found")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if not head_only:
            self.wfile.write(body)

    def do_HEAD(self):
        if not self.take_lang() or not self.clean_path():
            return
        if self.lang != "en" and urlparse(self.path).path == "/":
            return self.send_page(self.lang, head_only=True)
        return super().do_HEAD()

    def do_GET(self):
        if not self.take_lang() or not self.clean_path():
            return
        u = urlparse(self.path)
        if self.lang != "en" and u.path == "/":
            return self.send_page(self.lang)
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
            return self.send_json(200, public_fix(e))
        if u.path == "/api/comments":
            return self.comments_list(parse_qs(u.query))
        if u.path == "/api/page-comments":
            return self.page_comments_list((parse_qs(u.query).get("key") or [""])[0])
        if u.path == "/api/me":
            return self.send_json(200, {"user": self.user(), "methods": accounts.methods(dev_mail=self.is_editor())})
        if u.path.startswith("/api/auth/"):
            return self.auth_get(u.path[len("/api/auth/"):], parse_qs(u.query))
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
        if not self.take_lang():   # the API is the same in every language
            return
        u = urlparse(self.path)
        if u.path == "/api/chat":
            return self.chat()
        if u.path == "/api/site-interests":
            return self.site_interests()
        if u.path == "/api/review":
            return self.review()
        if u.path == "/api/comment":
            return self.comment()
        if u.path == "/api/comments/update":
            return self.comments_update()
        if u.path.startswith("/api/auth/"):
            return self.auth_post(u.path[len("/api/auth/"):])
        if u.path not in ("/api/interests", "/api/interests/hide", "/api/fixes/approve", "/api/fixes/suggest"):
            return self.send_json(404, {"error": "not found"})
        body = self.read_body()
        if not isinstance(body, dict):
            return self.send_json(400, {"error": "bad body"})
        key = str(body.get("key", ""))
        if not KEY_RE.match(key):
            return self.send_json(400, {"error": "bad key"})
        ip = self.client_ip()
        if not WRITE_RATE.allow(ip):
            return self.send_json(429, {"error": "Too many changes in a short time. Please wait a few minutes and try again."})
        state_file = FIXES_FILE if u.path.startswith("/api/fixes/") else STATE_FILE
        full = {"error": "The site cannot store more changes right now. Please try again later."}
        if u.path == "/api/interests":
            label = " ".join(str(body.get("label", "")).split())[:MAX_LABEL]
            if not label:
                return self.send_json(400, {"error": "empty label"})
            with LOCK:
                state = load_state()
                e = entry(state, key)
                if not any(a["label"].lower() == label.lower() for a in e["added"]):
                    if len(e["added"]) >= MAX_INTERESTS:
                        return self.send_json(409, {"error": f"This place already has {MAX_INTERESTS} added interests."})
                    if too_big(state_file, MAX_STATE_BYTES):
                        return self.send_json(507, full)
                    e["added"].append({"id": "u:" + uuid.uuid4().hex[:12], "label": label, "at": int(time.time())})
                    save_state(state)
                    audit(ip, "add", key, label)
            return self.send_json(200, e)
        if u.path == "/api/interests/hide":
            cid = str(body.get("id", ""))[:80]
            if not cid:
                return self.send_json(400, {"error": "missing id"})
            with LOCK:
                state = load_state()
                e = entry(state, key)
                if cid not in e["hidden"]:
                    if len(e["hidden"]) >= 2 * MAX_INTERESTS:
                        return self.send_json(409, {"error": "Too many interests are marked not applicable here."})
                    if too_big(state_file, MAX_STATE_BYTES):
                        return self.send_json(507, full)
                    e["hidden"].append(cid)
                    save_state(state)
                    audit(ip, "hide", key, cid)
            return self.send_json(200, e)
        if u.path == "/api/fixes/approve":
            who = visitor_id(ip)
            with LOCK:
                state = load_state(FIXES_FILE)
                e = fix_entry(state, key)
                approvers = e.setdefault("approvers", [])
                if who not in approvers:  # one approval per visitor
                    if too_big(state_file, MAX_STATE_BYTES):
                        return self.send_json(507, full)
                    approvers.append(who)
                    e["approvals"] += 1
                    save_state(state, FIXES_FILE)
                    audit(ip, "approve", key)
            return self.send_json(200, public_fix(e))
        text = str(body.get("text", "")).strip()[:MAX_SUGGESTION]  # /api/fixes/suggest
        if not text:
            return self.send_json(400, {"error": "empty text"})
        with LOCK:
            state = load_state(FIXES_FILE)
            e = fix_entry(state, key)
            if not any(x["text"] == text for x in e["suggestions"]):
                if len(e["suggestions"]) >= MAX_SUGGESTIONS:
                    return self.send_json(409, {"error": "This amendment has as many suggested wordings as the site can take."})
                if too_big(state_file, MAX_STATE_BYTES):
                    return self.send_json(507, full)
                e["suggestions"].append({"text": text, "at": int(time.time())})
                save_state(state, FIXES_FILE)
                audit(ip, "suggest", key, text[:200])
        return self.send_json(200, public_fix(e))

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

    def review(self):
        """Editor mode: append the owner's comment on one paragraph, with the paragraph and where it is, to REVIEW_FILE."""
        if not self.is_editor():
            return self.send_json(403, {"error": "comments are only possible on the owner's local copy (server.py --edit)"})
        body = self.read_body(64_000)
        if not isinstance(body, dict) or not str(body.get("comment", "")).strip():
            return self.send_json(400, {"error": "empty comment"})
        rec = {"id": uuid.uuid4().hex[:8], "at": time.strftime("%Y-%m-%d %H:%M:%S"), "from": "owner", "kind": "paragraph"}
        for k in ("comment", "text", "url", "page", "where"):
            rec[k] = str(body.get(k, "")).strip()[:MAX_REVIEW_TEXT]
        with LOCK:
            os.makedirs(os.path.dirname(REVIEW_FILE), exist_ok=True)
            with open(REVIEW_FILE, "a", encoding="utf-8") as f:
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        return self.send_json(200, {"id": rec["id"]})

    def comment(self):
        """A comment for the editors, on a whole requirement or on a highlighted passage of law: appended to REVIEW_FILE
        with the page, the passage and any chat the reader had about it. From anyone on a server without accounts,
        from a signed-in reader on one that has them. Nothing is published."""
        body = self.read_body(CHAT_MAX_BODY)
        if not isinstance(body, dict):
            return self.send_json(400, {"error": "bad body"})
        comment = str(body.get("comment", "")).strip()[:MAX_COMMENT]
        quote = str(body.get("quote", "")).strip()[:MAX_COMMENT]
        if not comment:
            return self.send_json(400, {"error": "empty comment"})
        url = str(body.get("url", ""))[:500]
        url = url if re.match(r"^https?://[^\s<>]+$", url) else ""
        key = str(body.get("key", ""))
        key = key if KEY_RE.match(key) else ""
        msgs = []
        for m in (body.get("messages") or [])[-CHAT_MAX_TURNS:]:
            role, text = (m or {}).get("role"), str((m or {}).get("content", "")).strip()[:CHAT_MAX_MESSAGE]
            if role in ("user", "assistant") and text:
                msgs.append({"role": role, "content": text})
        owner, ip, user = self.is_editor(), self.client_ip(), None
        if not owner and accounts.on():   # a server with accounts takes comments from signed-in readers only
            user = self.user() if self.json_post() else None
            if not user:
                return self.send_json(401, {"error": "Sign in to send a comment.", "signin": True})
        if not owner:
            if not WRITE_RATE.allow(ip):
                return self.send_json(429, {"error": "Too many comments in a short time. Please wait a few minutes."})
            if not COMMENT_RATE.allow("all"):
                return self.send_json(429, {"error": "The site has taken as many comments as it can today. Please come back tomorrow."})
        # "who" is the one-way hash of a reader's address; "user" the signed-in reader's id; "key" names the page for
        # /api/page-comments; "public": sent by a signed-in reader, under the notice that other readers see it.
        rec = {"id": uuid.uuid4().hex[:8], "at": time.strftime("%Y-%m-%d %H:%M:%S"), "from": "owner" if owner else "reader",
               "who": None if owner else visitor_id(ip), "user": user and user["id"], "kind": "passage" if quote else "requirement",
               "lang": getattr(self, "lang", "en") or "en", "comment": comment, "text": quote,
               "where": str(body.get("where", "")).strip()[:300], "page": str(body.get("page", "")).strip()[:300], "url": url,
               "key": key, "public": bool(user and key), "messages": msgs}
        with LOCK:
            full = not owner and too_big(REVIEW_FILE, MAX_REVIEW_BYTES)
            if not full:
                os.makedirs(os.path.dirname(REVIEW_FILE), exist_ok=True)
                with open(REVIEW_FILE, "a", encoding="utf-8") as f:
                    f.write(json.dumps(rec, ensure_ascii=False) + "\n")
                if not owner:
                    audit(ip, "comment", rec["id"], " ".join(comment.split())[:80])
        if full:
            return self.send_json(507, {"error": "The comment could not be saved. Please try again later."})
        return self.send_json(200, {"id": rec["id"], "to": "claude" if owner else "editors", "public": rec["public"]})

    # ---------- signing in (accounts.py) ----------

    def auth_get(self, what, q):
        """start/<provider>: off to Google or Apple. finish: back from there, in the browser that started."""
        if what in ("start/google", "start/apple"):
            if not SIGNIN_RATE.allow(self.client_ip()):
                return self.go("/", [self.make_cookie(SIGNIN_NOTE, "failed", 30, script=True)])
            back = accounts.safe_return((q.get("return") or ["/"])[0])
            try:
                where, secret = accounts.start(what[6:], back, self.own_address())
            except accounts.Refused:
                return self.go(back, [self.make_cookie(SIGNIN_NOTE, "failed", 30, script=True)])
            return self.go(where, [self.make_cookie(FLOW_COOKIE, secret, accounts.FLOW_SECONDS)])
        if what == "finish":
            gone = self.make_cookie(FLOW_COOKIE, "", 0)
            try:
                token, back = accounts.finish((q.get("c") or [""])[0], self.cookie(FLOW_COOKIE))
            except accounts.Refused as e:
                return self.go(e.back, [gone, self.make_cookie(SIGNIN_NOTE, "failed", 30, script=True)])
            return self.go(back, [gone, self.make_cookie(SESSION_COOKIE, token, accounts.SESSION_DAYS * 86400)])
        return self.send_json(404, {"error": "not found"})

    def auth_post(self, what):
        ip = self.client_ip()
        if what in ("callback/google", "callback/apple"):
            # Google or Apple sends the reader's browser here with a form; it comes from their site, so without our
            # cookies. A good answer earns a one-time ticket, which the browser then brings to /api/auth/finish.
            n = int(self.headers.get("Content-Length") or 0)
            form = {}
            if 0 < n <= 32_000:
                form = {k: v[0] for k, v in parse_qs(self.rfile.read(n).decode("utf-8", "replace")).items()}
            try:
                ticket = accounts.callback(what[9:], form)
            except accounts.Refused as e:
                return self.go(e.back, [self.make_cookie(SIGNIN_NOTE, "failed", 30, script=True)])
            return self.go(f"/api/auth/finish?c={quote(ticket)}")
        if not self.json_post():
            return self.send_json(415, {"error": "JSON expected"})
        body = self.read_body(MAX_BODY)
        body = body if isinstance(body, dict) else {}
        if what == "email":
            email = accounts.clean_email(body.get("email"))
            if not email:
                return self.send_json(400, {"error": "Please enter a valid email address.", "field": "email"})
            show = None
            if self.is_editor() and not accounts.mail_on():   # the owner's local copy without a mail server
                show = lambda to, code: print(f"Sign-in code for {to}: {code}", flush=True)
            elif not accounts.mail_on():
                return self.send_json(404, {"error": "Signing in by email is not set up on this server."})
            if not (MAIL_RATE.allow(ip) and MAIL_TO_RATE.allow(email) and MAIL_TOTAL.allow("all")):
                return self.send_json(429, {"error": "Too many codes for now. Please try again later."})
            try:
                accounts.send_code(email, self.lang, show)
            except accounts.Refused as e:
                return self.send_json(502, {"error": str(e)})
            with LOCK:
                audit(ip, "signin-code", visitor_id(email))
            return self.send_json(200, {"sent": True, "minutes": accounts.CODE_MINUTES})
        if what == "email/verify":
            email = accounts.clean_email(body.get("email"))
            if not SIGNIN_RATE.allow(ip):
                return self.send_json(429, {"error": "Too many attempts. Please try again later."})
            try:
                if not email:
                    raise accounts.Refused("That code is not right, or it has expired. Ask for a new one.")
                user, token = accounts.check_code(email, body.get("code"))
            except accounts.Refused as e:
                return self.send_json(400, {"error": str(e)})
            return self.send_json(200, {"user": user}, [self.make_cookie(SESSION_COOKIE, token, accounts.SESSION_DAYS * 86400)])
        if what == "name":
            user = self.user()
            if not user:
                return self.send_json(401, {"error": "Sign in first.", "signin": True})
            name = " ".join(re.sub(r"[\x00-\x1f\x7f<>]", " ", str(body.get("name", ""))).split())[:MAX_NAME]
            if not WRITE_RATE.allow(ip):
                return self.send_json(429, {"error": "Too many changes in a short time. Please wait a few minutes."})
            return self.send_json(200, {"user": accounts.rename(user["id"], name)})
        if what == "signout":
            accounts.sign_out(self.cookie(SESSION_COOKIE))
            return self.send_json(200, {"user": None}, [self.make_cookie(SESSION_COOKIE, "", 0)])
        if what == "delete":
            user = self.user()
            if not user:
                return self.send_json(401, {"error": "Sign in first.", "signin": True})
            accounts.delete_user(user["id"])
            with LOCK:
                audit(ip, "account-deleted", user["id"])
            return self.send_json(200, {"user": None}, [self.make_cookie(SESSION_COOKIE, "", 0)])
        return self.send_json(404, {"error": "not found"})

    def page_comments_list(self, key):
        """Readers: the comments about one page. Anyone gets their number; a signed-in reader gets the comments."""
        if not KEY_RE.match(key):
            return self.send_json(400, {"error": "bad key"})
        if not accounts.on():   # no accounts here: nobody could read them
            return self.send_json(200, {"count": 0, "comments": [], "signin": False})
        user = self.user()
        with LOCK:
            recs, state = page_comments(key), load_state(REVIEW_STATE_FILE)
        people = accounts.users_by_id(rec["user"] for rec in recs)   # a deleted account's comments are no longer shown
        out = []
        for rec in recs:
            st = state.get(rec["id"]) or {}
            status, mine = st.get("status", "new"), bool(user) and rec["user"] == user["id"]
            seen = {"all": status != "hidden", "handled": status in ("answered", "applied", "declined"), "own": False}[COMMENTS_SHOWN]
            if rec["user"] in people and (seen or mine):
                shown = {k: v for k, v in rec.items() if k != "user"}
                out.append(dict(shown, status=status, reply=st.get("reply", ""), mine=mine, name=people[rec["user"]]["name"]))
        out = out[-MAX_PAGE_COMMENTS:]
        if not user:
            return self.send_json(200, {"count": len(out), "comments": [], "signin": True})
        return self.send_json(200, {"count": len(out), "comments": out})

    def comments_list(self, q):
        """Editors: the comment queue, oldest first, each comment with its status and reply. ?status=new (the default),
        answered, applied, declined or all; ?after=<id> gives only the comments that came after that one."""
        no = self.editor_access()
        if no:
            return self.send_json(no[0], {"error": no[1]})
        want = (q.get("status") or ["new"])[0]
        after = (q.get("after") or [""])[0]
        sender = (q.get("from") or ["all"])[0]
        if want != "all" and want not in COMMENT_STATUSES:
            return self.send_json(400, {"error": "status is one of: all, " + ", ".join(COMMENT_STATUSES)})
        if sender not in ("all", "owner", "reader"):
            return self.send_json(400, {"error": "from is one of: all, owner, reader"})
        with LOCK:
            state, queue = load_state(REVIEW_STATE_FILE), read_queue()
        out, seen = [], not after
        for rec in queue:
            if not seen:
                seen = rec["id"] == after
                continue
            rec.setdefault("from", "owner")   # the owner's paragraph comments from before readers could comment
            st = state.get(rec["id"]) or {}
            rec["status"] = st.get("status", "new")
            for k in ("reply", "note", "updated"):
                if st.get(k):
                    rec[k] = st[k]
            if want in ("all", rec["status"]) and sender in ("all", rec["from"]):
                out.append(rec)
        more, out = len(out) > MAX_LISTED, out[:MAX_LISTED]
        people = accounts.users_by_id(rec.get("user") for rec in out)
        for rec in out:
            if rec.get("user") in people:
                rec["user_email"], rec["user_name"] = people[rec["user"]]["email"], people[rec["user"]]["name"]
        return self.send_json(200, {"comments": out, "more": more, "total": len(queue)})

    def comments_update(self):
        """Editors: record what was done with one comment: {id, status, reply?, note?}. The reply is for its author (shown
        to readers once comments are visible on the site); the note is for the editors only."""
        no = self.editor_access()
        if no:
            return self.send_json(no[0], {"error": no[1]})
        body = self.read_body(MAX_BODY)
        if not isinstance(body, dict):
            return self.send_json(400, {"error": "bad body"})
        cid, status = str(body.get("id", "")), str(body.get("status", ""))
        if not re.match(r"^[0-9a-f]{8}$", cid) or status not in COMMENT_STATUSES:
            return self.send_json(400, {"error": "id and status (" + ", ".join(COMMENT_STATUSES) + ") are required"})
        with LOCK:
            known = any(rec["id"] == cid for rec in read_queue())
            if known:
                state = load_state(REVIEW_STATE_FILE)
                e = state.setdefault(cid, {})
                e["status"], e["updated"] = status, time.strftime("%Y-%m-%d %H:%M:%S")
                for k in ("reply", "note"):
                    if k in body:
                        e[k] = str(body[k]).strip()[:MAX_REPLY]
                save_state(state, REVIEW_STATE_FILE)
        if not known:
            return self.send_json(404, {"error": "no such comment"})
        return self.send_json(200, {"id": cid, "status": status})

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
        ip = self.client_ip()
        if not CHAT_RATE.allow(ip):
            return self.send_json(429, {"reply": None, "error": "Too many messages in a short time. Please wait a few minutes before asking more."})
        if not CHAT_TOTAL.allow("all"):
            return self.send_json(429, {"reply": None, "error": "The chat has answered as many questions as it can today. Please come back tomorrow."})
        save_comment(key, cid, msgs, title)
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
    global COMMENT_RATE
    COMMENT_RATE = RateLimit([(int(os.environ.get("FREEDOM_COMMENTS_DAILY") or COMMENTS_DAILY), 86400)])
    global MAIL_TOTAL
    MAIL_TOTAL = RateLimit([(int(os.environ.get("FREEDOM_MAIL_DAILY") or MAIL_DAILY), 86400)])
    srv = ThreadingHTTPServer((a.host, a.port), Handler)
    print(f"Freedom Map on http://{'localhost' if a.host in ('127.0.0.1', '0.0.0.0') else a.host}:{a.port}/  (Ctrl+C to stop)")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
