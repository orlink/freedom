"""Accounts for the Freedom Map: who a signed-in reader is. Standard library only; used by server.py.

A reader signs in with a code sent to their email address, with Google or with Apple. All three prove one thing, that
the reader holds an email address, and that address is the account: signing in another way with the same address
reaches the same account. No passwords exist. What is kept, in data/state/accounts.db (SQLite; git-ignored, never
served, never uploaded by tools/deploy.sh):

    users       id, email, name (as Google or Apple gave it; empty for email sign-in), when created, when last seen
    identities  which Google or Apple account belongs to which user
    sessions    the hash of each sign-in token (the token itself lives only in the reader's cookie), valid 60 days
    codes       the keyed hash of the last emailed code per address, valid 10 minutes, five tries

Each way of signing in exists only when the server's .env configures it (docs/HOSTING.md):

    FREEDOM_SMTP_HOST, FREEDOM_SMTP_PORT, FREEDOM_SMTP_USER, FREEDOM_SMTP_PASSWORD, FREEDOM_MAIL_FROM   emailed codes
    FREEDOM_GOOGLE_CLIENT_ID    the OAuth client "Freedom Map" (Google Cloud console), a public identifier
    FREEDOM_APPLE_CLIENT_ID     the Services ID (Apple Developer), a public identifier
    FREEDOM_SITE_URL            the site's own address, for the return address given to Google and Apple
                                (default https://free.kredor.com; a local copy uses its own address)

Google and Apple answer with a signed statement (an OpenID Connect ID token) posted to /api/auth/callback/<provider>.
Its signature is checked here against the provider's published keys, so the server needs no secret of theirs.
"""
import base64, hashlib, hmac, json, os, re, secrets, smtplib, sqlite3, ssl, threading, time, urllib.parse, urllib.request
from email.message import EmailMessage

ROOT = os.path.dirname(os.path.abspath(__file__))
DB_FILE = os.path.join(ROOT, "data", "state", "accounts.db")
SESSION_DAYS = 60
CODE_MINUTES = 10
CODE_TRIES = 5
FLOW_SECONDS = 600       # a Google or Apple sign-in must come back within this time
MAX_FLOWS = 2000         # sign-ins under way at once, whole site
EMAIL_RE = re.compile(r"^[^@\s<>\"',;]{1,64}@[^@\s<>\"',;]{1,190}\.[^@\s<>\"',;.]{2,24}$")
PEPPER = secrets.token_bytes(32)   # keys the hashes of emailed codes; a restart forgets the codes still under way

PROVIDERS = {
    "google": {
        "env": "FREEDOM_GOOGLE_CLIENT_ID",
        "authorize": "https://accounts.google.com/o/oauth2/v2/auth",
        "keys": "https://www.googleapis.com/oauth2/v3/certs",
        "issuers": ("https://accounts.google.com", "accounts.google.com"),
        "params": {"response_type": "id_token", "scope": "openid email profile", "prompt": "select_account"},
    },
    "apple": {
        "env": "FREEDOM_APPLE_CLIENT_ID",
        "authorize": "https://appleid.apple.com/auth/authorize",
        "keys": "https://appleid.apple.com/auth/keys",
        "issuers": ("https://appleid.apple.com",),
        "params": {"response_type": "code id_token", "scope": "name email"},
    },
}

MAIL = {
    "en": ("{code} is your Freedom Map sign-in code",
           "Your sign-in code for Freedom Map is {code}. It is valid for {minutes} minutes.\n\n"
           "If you did not ask for it, ignore this message: nobody can sign in without the code.\n\n{site}\n"),
    "bg": ("{code} е вашият код за вход в Карта на свободата",
           "Вашият код за вход в „Карта на свободата“ е {code}. Валиден е {minutes} минути.\n\n"
           "Ако не сте го поискали, не обръщайте внимание на това съобщение: без кода никой не може да влезе.\n\n{site}\n"),
}


class Refused(Exception):
    """A sign-in that cannot go on; the message is safe to show to the reader. back: the page the reader came from,
    where it is known."""

    def __init__(self, message, back="/"):
        super().__init__(message)
        self.back = back


# ---------- configuration ----------

def env(name):
    return (os.environ.get(name) or "").strip()


def client_id(provider):
    return env(PROVIDERS[provider]["env"])


def mail_on():
    return bool(env("FREEDOM_SMTP_HOST"))


def methods(dev_mail=False):
    """Which ways of signing in this server offers. dev_mail: the owner's local copy, where a code is printed in the
    server's terminal when no mail server is configured."""
    return {"email": mail_on() or dev_mail, "google": bool(client_id("google")), "apple": bool(client_id("apple"))}


def on():
    """Does this server have accounts at all? (The owner's local copy alone does not count.)"""
    return any(methods().values())


def site_url():
    return env("FREEDOM_SITE_URL").rstrip("/") or "https://free.kredor.com"


# ---------- the store ----------

_db_lock = threading.Lock()
_db_ready = False
SCHEMA = """
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE, name TEXT NOT NULL DEFAULT '',
                                  created INTEGER NOT NULL, seen INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS identities (provider TEXT NOT NULL, sub TEXT NOT NULL,
                                       user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                                       PRIMARY KEY (provider, sub));
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY,
                                     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                                     created INTEGER NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS codes (email TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires INTEGER NOT NULL,
                                  tries INTEGER NOT NULL DEFAULT 0);
"""


class _Store:
    """One short transaction on the accounts file: `with _Store() as db:` commits, or rolls back on an error."""

    def __enter__(self):
        global _db_ready
        _db_lock.acquire()
        try:
            os.makedirs(os.path.dirname(DB_FILE), exist_ok=True)
            self.db = sqlite3.connect(DB_FILE, timeout=10)
            self.db.row_factory = sqlite3.Row
            self.db.execute("PRAGMA foreign_keys = ON")
            if not _db_ready:
                self.db.executescript(SCHEMA)
                _db_ready = True
            return self.db
        except Exception:
            _db_lock.release()
            raise

    def __exit__(self, kind, *_):
        try:
            self.db.commit() if kind is None else self.db.rollback()
            self.db.close()
        finally:
            _db_lock.release()


def _hash(token):
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _public(row):
    return {"id": row["id"], "email": row["email"] or "", "name": row["name"]} if row else None


def clean_email(email):
    """The address as the account knows it (lower case), or "" when it is not an address."""
    email = str(email or "").strip().lower()
    return email if len(email) <= 254 and EMAIL_RE.match(email) else ""


def _user_for(db, email, name="", provider=None, sub=None):
    """The user who holds this proven email address or this provider account, made on first sign-in."""
    now, row = int(time.time()), None
    if provider:
        row = db.execute("SELECT u.* FROM identities i JOIN users u ON u.id = i.user_id WHERE i.provider = ? AND i.sub = ?",
                         (provider, sub)).fetchone()
    if not row and email:
        row = db.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
    if not row:
        uid = secrets.token_hex(8)
        db.execute("INSERT INTO users (id, email, name, created, seen) VALUES (?, ?, ?, ?, ?)",
                   (uid, email or None, name[:120], now, now))
        row = db.execute("SELECT * FROM users WHERE id = ?", (uid,)).fetchone()
    else:
        db.execute("UPDATE users SET seen = ?, name = CASE WHEN name = '' THEN ? ELSE name END WHERE id = ?",
                   (now, name[:120], row["id"]))
        row = db.execute("SELECT * FROM users WHERE id = ?", (row["id"],)).fetchone()
    if provider:
        db.execute("INSERT OR IGNORE INTO identities (provider, sub, user_id) VALUES (?, ?, ?)", (provider, sub, row["id"]))
    return row


def _new_session(db, user_id):
    token, now = secrets.token_urlsafe(32), int(time.time())
    db.execute("DELETE FROM sessions WHERE expires < ?", (now,))
    db.execute("INSERT INTO sessions (token_hash, user_id, created, expires) VALUES (?, ?, ?, ?)",
               (_hash(token), user_id, now, now + SESSION_DAYS * 86400))
    return token


def session_user(token):
    """The signed-in user this token belongs to, or None."""
    if not token or len(token) > 200 or not os.path.exists(DB_FILE):
        return None
    with _Store() as db:
        row = db.execute("SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires > ?",
                         (_hash(token), int(time.time()))).fetchone()
        return _public(row)


def sign_out(token):
    if token and os.path.exists(DB_FILE):
        with _Store() as db:
            db.execute("DELETE FROM sessions WHERE token_hash = ?", (_hash(token),))


def delete_user(user_id):
    """Remove the account: the user, their sign-ins and their Google or Apple links. Their comments stay in the
    editors' queue, without a name."""
    with _Store() as db:
        db.execute("DELETE FROM codes WHERE email = (SELECT email FROM users WHERE id = ?)", (user_id,))
        db.execute("DELETE FROM users WHERE id = ?", (user_id,))


def rename(user_id, name):
    """Set the name shown with the user's comments; answers the user."""
    with _Store() as db:
        db.execute("UPDATE users SET name = ? WHERE id = ?", (name, user_id))
        return _public(db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone())


def users_by_id(ids):
    """For the editors' list: {user id: {"email", "name"}} of those who still have an account."""
    ids = [i for i in set(ids) if i]
    if not ids or not os.path.exists(DB_FILE):
        return {}
    with _Store() as db:
        rows = db.execute(f"SELECT * FROM users WHERE id IN ({','.join('?' * len(ids))})", ids).fetchall()
        return {r["id"]: {"email": r["email"] or "", "name": r["name"]} for r in rows}


# ---------- signing in with an emailed code ----------

def _code_hash(email, code):
    return hmac.new(PEPPER, f"{email}:{code}".encode("utf-8"), hashlib.sha256).hexdigest()


def send_code(email, lang="en", show=None):
    """Make a sign-in code for this address and email it. show: on the owner's local copy without a mail server,
    a function that shows the code instead (the server's terminal). Raises Refused when it cannot be sent."""
    code = f"{secrets.randbelow(10 ** 6):06d}"
    with _Store() as db:
        db.execute("DELETE FROM codes WHERE expires < ?", (int(time.time()),))
        db.execute("INSERT OR REPLACE INTO codes (email, code_hash, expires, tries) VALUES (?, ?, ?, 0)",
                   (email, _code_hash(email, code), int(time.time()) + CODE_MINUTES * 60))
    if not mail_on():
        if show:
            return show(email, code)
        raise Refused("Signing in by email is not set up on this server.")
    subject, text = MAIL.get(lang, MAIL["en"])
    msg = EmailMessage()
    msg["Subject"] = subject.format(code=code)
    msg["From"] = env("FREEDOM_MAIL_FROM") or env("FREEDOM_SMTP_USER")
    msg["To"] = email
    msg.set_content(text.format(code=code, minutes=CODE_MINUTES, site=site_url()))
    host, port = env("FREEDOM_SMTP_HOST"), int(env("FREEDOM_SMTP_PORT") or 587)
    try:
        if port == 465:
            smtp = smtplib.SMTP_SSL(host, port, timeout=20, context=_tls())
        else:
            smtp = smtplib.SMTP(host, port, timeout=20)
        with smtp:
            if port != 465 and host not in ("localhost", "127.0.0.1"):
                smtp.starttls(context=_tls())   # never send the mail password or a code in the clear
            if env("FREEDOM_SMTP_USER"):
                smtp.login(env("FREEDOM_SMTP_USER"), env("FREEDOM_SMTP_PASSWORD"))
            smtp.send_message(msg)
    except (OSError, smtplib.SMTPException) as e:
        print(f"mail: could not send a sign-in code ({type(e).__name__}: {e})", flush=True)
        raise Refused("The email could not be sent. Please try again later.")


def check_code(email, code):
    """Sign in with an emailed code: (user, session token), or Refused. A code works once and allows five tries."""
    code = re.sub(r"\s", "", str(code or ""))
    with _Store() as db:
        row = db.execute("SELECT * FROM codes WHERE email = ?", (email,)).fetchone()
        ok = bool(row) and row["expires"] > time.time() and row["tries"] < CODE_TRIES \
            and hmac.compare_digest(row["code_hash"], _code_hash(email, code))
        if ok:
            db.execute("DELETE FROM codes WHERE email = ?", (email,))
            user = _user_for(db, email)
            return _public(user), _new_session(db, user["id"])
        if row:
            db.execute("UPDATE codes SET tries = tries + 1 WHERE email = ?", (email,))
    raise Refused("That code is not right, or it has expired. Ask for a new one.")


# ---------- signing in with Google or Apple ----------
# 1. start(): the reader's browser gets a cookie holding a secret and goes to the provider with `state` (the secret's
#    hash) and a `nonce` kept here. 2. callback(): the provider posts its signed statement; it must carry that nonce.
#    Being posted from another site, this request has no cookie, so it only earns a one-time ticket. 3. finish():
#    the browser comes back with the ticket and the cookie; only the browser that started may finish.

_flows, _tickets, _flow_lock = {}, {}, threading.Lock()


def _sweep(now):
    for box in (_flows, _tickets):
        for k in [k for k, v in box.items() if now - v["at"] > FLOW_SECONDS]:
            del box[k]


def safe_return(path):
    """Where to send the reader after signing in: a page of this site only."""
    path = str(path or "")
    ok = len(path) <= 2000 and re.match(r"^/(?![/\\])[^\s\\]*$", path) and not path.startswith("/api/")
    return path if ok else "/"


def start(provider, return_to, base):
    """Begin a sign-in: (the provider's address to go to, the secret for the browser's cookie)."""
    if provider not in PROVIDERS or not client_id(provider):
        raise Refused("This way of signing in is not set up on this server.")
    secret, nonce, now = secrets.token_urlsafe(32), secrets.token_urlsafe(24), time.time()
    state = _hash(secret)[:40]
    with _flow_lock:
        _sweep(now)
        if len(_flows) >= MAX_FLOWS:
            raise Refused("Too many people are signing in right now. Please try again in a few minutes.")
        _flows[state] = {"provider": provider, "nonce": nonce, "return": safe_return(return_to), "at": now}
    q = dict(PROVIDERS[provider]["params"], client_id=client_id(provider), response_mode="form_post",
             redirect_uri=f"{base}/api/auth/callback/{provider}", state=state, nonce=nonce)
    return PROVIDERS[provider]["authorize"] + "?" + urllib.parse.urlencode(q), secret


def callback(provider, form):
    """The provider's answer (the posted form, as a dict). Returns the ticket for finish()."""
    state = str(form.get("state", ""))
    with _flow_lock:
        _sweep(time.time())
        flow = _flows.pop(state, None)
    if not flow or flow["provider"] != provider:
        raise Refused("This sign-in took too long or was already used. Please try again.")
    if form.get("error") or not form.get("id_token"):
        raise Refused("The sign-in was cancelled.", flow["return"])
    try:
        claims = verify_id_token(provider, str(form["id_token"]), flow["nonce"])
    except Refused as e:
        raise Refused(str(e), flow["return"])
    email = clean_email(claims.get("email")) if claims.get("email_verified") in (True, "true") else ""
    name = str(claims.get("name") or "")
    if not name and form.get("user"):   # Apple sends the name once, beside the token, on the first sign-in
        try:
            n = json.loads(form["user"]).get("name") or {}
            name = " ".join(str(n.get(k) or "") for k in ("firstName", "lastName")).strip()
        except (ValueError, AttributeError):
            pass
    with _Store() as db:
        user = _user_for(db, email, name.strip(), provider, str(claims["sub"]))
        uid = user["id"]
    ticket = secrets.token_urlsafe(24)
    with _flow_lock:
        _tickets[ticket] = {"user": uid, "state": state, "return": flow["return"], "at": time.time()}
    return ticket


def finish(ticket, secret):
    """The browser is back from the provider: (session token, where to go), or Refused."""
    with _flow_lock:
        _sweep(time.time())
        done = _tickets.pop(str(ticket or ""), None)
    if not done or not secret or not hmac.compare_digest(_hash(secret)[:40], done["state"]):
        raise Refused("This sign-in could not be completed in this browser. Please try again.")
    with _Store() as db:
        if not db.execute("SELECT 1 FROM users WHERE id = ?", (done["user"],)).fetchone():
            raise Refused("This sign-in could not be completed. Please try again.")
        return _new_session(db, done["user"]), done["return"]


# ---------- checking a provider's signed statement ----------

_keys, _keys_lock = {}, threading.Lock()   # provider -> {"at": when fetched, "keys": {kid: jwk}}


def _tls():
    """Certificates to check the provider's and the mail server's identity against: the bundle the chat's packages
    bring where there is one (some Pythons come without a store of their own), else the system's."""
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()


def _provider_key(provider, kid):
    """The provider's published signing key with this id; the list is kept for a day and fetched again (at most
    once a minute) when a token names a key that is not in it."""
    now = time.time()
    with _keys_lock:
        have = _keys.get(provider) or {"at": 0, "keys": {}}
        if (kid not in have["keys"] and now - have["at"] > 60) or now - have["at"] > 86400:
            try:
                req = urllib.request.Request(PROVIDERS[provider]["keys"], headers={"User-Agent": "freedom-map/1"})
                with urllib.request.urlopen(req, timeout=15, context=_tls()) as r:
                    listed = json.loads(r.read(200_000).decode("utf-8")).get("keys", [])
                have = {"at": now, "keys": {k["kid"]: k for k in listed if k.get("kty") == "RSA" and k.get("kid")}}
            except (OSError, ValueError, KeyError, TypeError) as e:
                print(f"sign-in: could not fetch {provider}'s keys ({type(e).__name__}: {e})", flush=True)
                have = {"at": now, "keys": have["keys"]}
            _keys[provider] = have
        return have["keys"].get(kid)


def _b64(s):
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def rs256_ok(n, e, message, signature):
    """RSASSA-PKCS1-v1_5 with SHA-256: is `signature` the key's signature of `message`? The expected block is built
    whole and compared whole, so nothing in the signature is parsed."""
    size = (n.bit_length() + 7) // 8
    if n.bit_length() < 2048 or len(signature) != size or e < 3:
        return False
    digest_info = bytes.fromhex("3031300d060960864801650304020105000420") + hashlib.sha256(message).digest()
    expected = b"\x00\x01" + b"\xff" * (size - len(digest_info) - 3) + b"\x00" + digest_info
    return hmac.compare_digest(pow(int.from_bytes(signature, "big"), e, n).to_bytes(size, "big"), expected)


def verify_id_token(provider, token, nonce):
    """The claims of a provider's ID token, once its signature, issuer, audience, time and nonce are all right."""
    bad = Refused("The sign-in could not be confirmed. Please try again.")
    try:
        head, body, sig = token.split(".")
        header, claims, signature = json.loads(_b64(head)), json.loads(_b64(body)), _b64(sig)
    except (ValueError, TypeError):
        raise bad
    if not isinstance(header, dict) or not isinstance(claims, dict) or header.get("alg") != "RS256":
        raise bad
    key = _provider_key(provider, header.get("kid"))
    try:
        n, e = int.from_bytes(_b64(key["n"]), "big"), int.from_bytes(_b64(key["e"]), "big")
    except (TypeError, KeyError, ValueError):
        raise bad
    if not rs256_ok(n, e, f"{head}.{body}".encode("ascii"), signature):
        raise bad
    now, aud = time.time(), claims.get("aud")
    try:
        fresh = float(claims["exp"]) > now - 60 and float(claims.get("iat", now)) < now + 300
    except (KeyError, TypeError, ValueError):
        raise bad
    if not (fresh and claims.get("iss") in PROVIDERS[provider]["issuers"] and aud == client_id(provider)
            and claims.get("sub") and isinstance(claims.get("nonce"), str)
            and hmac.compare_digest(claims["nonce"], nonce)):
        raise bad
    return claims
