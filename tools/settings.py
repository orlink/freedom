#!/usr/bin/env python3
"""The Freedom Map's private settings: the lines in .env that are never committed and never uploaded with the site.

  python3 tools/settings.py mail     ask for the mail service's details, check them, save them in this copy's .env
  python3 tools/settings.py push     copy the mail settings and the editor key from this copy's .env to the live server
  python3 tools/settings.py show     which settings this copy and the live server hold (names only, never values)

"mail" asks for the password without showing it, signs in to the mail service once to check it (no email is sent
unless you ask for a test message), and only then saves. "push" sends the lines to the server in a file that is
deleted there at once, keeps the server's previous .env as C:\\freedom\\env.bak, and restarts the service. Nothing here
ever prints a value, so an editor's Claude can run "show" and "push" without seeing a password or key. Other lines
in either .env (the API key) are left exactly as they are.

The server and the ssh key are those of tools/deploy.sh (FREEDOM_HOST, FREEDOM_SSH_KEY change them).
"""
import argparse, base64, getpass, os, re, smtplib, subprocess, sys, tempfile
from email.message import EmailMessage

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import accounts   # noqa: E402  (for the same certificate store the server uses)

ENV = os.path.join(ROOT, ".env")
MAIL = ("FREEDOM_SMTP_HOST", "FREEDOM_SMTP_PORT", "FREEDOM_SMTP_USER", "FREEDOM_SMTP_PASSWORD", "FREEDOM_MAIL_FROM")
PUSHED = MAIL + ("FREEDOM_EDITOR_KEY",)
HOST = os.environ.get("FREEDOM_HOST") or "Administrator@38.86.91.8"
KEY = os.environ.get("FREEDOM_SSH_KEY") or os.path.expanduser("~/codex_migrate_nopass_key")
SSH = ["-i", KEY, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "LogLevel=ERROR"]
REMOTE_NEW = "C:/MigrationTools/freedom-settings.tmp"


def name_of(line):
    """The setting a line of .env is about ("" for a comment or a blank line), read the way server.py reads it."""
    line = line.strip()
    if line.startswith("export "):
        line = line[7:].strip()
    return "" if not line or line.startswith("#") or "=" not in line else line.split("=", 1)[0].strip()


def read_env():
    """(the lines of this copy's .env, {name: value})."""
    try:
        with open(ENV, encoding="utf-8") as f:
            lines = f.read().splitlines()
    except OSError:
        lines = []
    values = {}
    for line in lines:
        if name_of(line):
            values[name_of(line)] = line.split("=", 1)[1].strip().strip('"').strip("'")
    return lines, values


def save_env(new):
    """Put these settings into this copy's .env in place of any earlier lines for them; every other line stays."""
    lines, _ = read_env()
    keep = [line for line in lines if name_of(line) not in new]
    text = "\n".join(keep + [f"{k}={v}" for k, v in new.items()]) + "\n"
    fd, tmp = tempfile.mkstemp(dir=ROOT, prefix=".env.")   # readable by its owner only
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp, ENV)
    except BaseException:
        os.unlink(tmp)
        raise


def ask(question, default=""):
    answer = input(f"{question}{f' [{default}]' if default else ''}: ").strip()
    return answer or default


def plain(value, what):
    if not value or re.search(r"[\r\n]", value) or value != value.strip() or value[:1] in "\"'" or value[-1:] in "\"'":
        sys.exit(f"That {what} cannot be saved: it is empty, or starts or ends with a space or a quotation mark.")
    return value


def connect(host, port, user, password):
    """Sign in to the mail service; the open connection. Raises OSError or smtplib.SMTPException."""
    tls = accounts._tls()
    smtp = smtplib.SMTP_SSL(host, port, timeout=20, context=tls) if port == 465 else smtplib.SMTP(host, port, timeout=20)
    try:
        if port != 465:
            smtp.starttls(context=tls)   # never send the password in the clear
        smtp.login(user, password)
    except BaseException:
        smtp.close()
        raise
    return smtp


def mail():
    _, old = read_env()
    print("The mail service that sends the sign-in codes. Press Return to accept what is in [brackets].\n"
          "With Brevo: the login and the key are on the page \"SMTP & API\" (make a new SMTP key for the map).\n")
    host = plain(ask("Server", old.get("FREEDOM_SMTP_HOST") or "smtp-relay.brevo.com"), "server")
    port = ask("Port", old.get("FREEDOM_SMTP_PORT") or "587")
    if not port.isdigit():
        sys.exit("The port is a number, usually 587 or 465.")
    user = plain(ask("Login", old.get("FREEDOM_SMTP_USER", "")), "login")
    password = plain(getpass.getpass("Key or password (not shown as you paste it): "), "key")
    was = re.search(r"<([^<>]+)>", old.get("FREEDOM_MAIL_FROM", ""))
    sender = plain(ask("Sender's address (one the mail service lets you send from)",
                       was.group(1) if was else "no-reply@kredor.com"), "address")
    if not accounts.EMAIL_RE.match(sender):
        sys.exit("That does not look like an email address.")
    new = {"FREEDOM_SMTP_HOST": host, "FREEDOM_SMTP_PORT": port, "FREEDOM_SMTP_USER": user,
           "FREEDOM_SMTP_PASSWORD": password, "FREEDOM_MAIL_FROM": f"Freedom Map <{sender}>"}
    print("\nSigning in to the mail service to check…")
    try:
        smtp = connect(host, int(port), user, password)
    except (OSError, smtplib.SMTPException) as e:
        sys.exit(f"The mail service did not accept that ({type(e).__name__}: {e}).\nNothing was saved.")
    with smtp:
        print("Accepted.")
        to = ask("Send a test message to (your own address; Return to skip)")
        if to:
            msg = EmailMessage()
            msg["Subject"], msg["From"], msg["To"] = "Freedom Map: test message", new["FREEDOM_MAIL_FROM"], to
            msg.set_content("The Freedom Map can send email through this mail service.\n")
            try:
                smtp.send_message(msg)
                print(f"Sent. If it does not arrive, the mail service may not allow {sender} as a sender.")
            except (OSError, smtplib.SMTPException) as e:
                sys.exit(f"The test message was refused ({type(e).__name__}: {e}).\nNothing was saved.")
    save_env(new)
    print(f"Saved in {ENV}. The local copy (--edit) picks it up by itself within a few seconds.")
    if ask("Put the same settings on the live server now? (y/n)", "n").lower().startswith("y"):
        push()
    else:
        print("For the live site, later: python3 tools/settings.py push")


def powershell(script, quiet=False):
    """Run a PowerShell script on the live server; (exit code, what it printed)."""
    enc = base64.b64encode(script.encode("utf-16-le")).decode("ascii")
    r = subprocess.run(["ssh", *SSH, HOST, f"powershell -NoProfile -NonInteractive -EncodedCommand {enc}"],
                       capture_output=True, text=True)
    out = (r.stdout + r.stderr).strip()
    if "#< CLIXML" in out:   # PowerShell's wrapped error stream: keep only what came before it
        out = out.split("#< CLIXML")[0].strip() or "PowerShell reported an error."
    return r.returncode, out


MERGE = r'''$ErrorActionPreference = "Stop"; $ProgressPreference = "SilentlyContinue"
$new = "C:\MigrationTools\freedom-settings.tmp"; $envFile = "C:\freedom\app\.env"
$utf8 = New-Object System.Text.UTF8Encoding($false)
try {
  $add = @([IO.File]::ReadAllLines($new, $utf8) | Where-Object { $_ -match "^[A-Z_]+=." })
  if ($add.Count -eq 0) { throw "no settings arrived" }
  $names = @($add | ForEach-Object { $_.Split("=")[0] })
  $old = @()
  if (Test-Path $envFile) { $old = @([IO.File]::ReadAllLines($envFile, $utf8)); Copy-Item $envFile C:\freedom\env.bak -Force }
  $keep = @($old | Where-Object { $names -notcontains (($_ -replace "^\s*(export\s+)?", "").Split("=")[0].Trim()) })
  [IO.File]::WriteAllText($envFile, ((@($keep) + @($add)) -join "`n") + "`n", $utf8)
  "saved " + $add.Count + " settings; " + $keep.Count + " other lines kept"
} finally { Remove-Item $new -ErrorAction SilentlyContinue }
Restart-Service freedom
foreach ($i in 1..20) {
  try { if ((Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://127.0.0.1:8090/).StatusCode -eq 200) { "service up"; exit 0 } } catch {}
  Start-Sleep -Milliseconds 500
}
"service did not answer on 127.0.0.1:8090; see C:\freedom\logs"; exit 1'''

NAMES = r'''$ProgressPreference = "SilentlyContinue"
if (Test-Path C:\freedom\app\.env) { Get-Content C:\freedom\app\.env | ForEach-Object {
  $l = ($_ -replace "^\s*(export\s+)?", ""); if ($l -and -not $l.StartsWith("#") -and $l.Contains("=")) { $l.Split("=")[0].Trim() } } }'''


def push():
    _, values = read_env()
    send = {k: values[k] for k in PUSHED if values.get(k)}
    if not send:
        sys.exit(f"{ENV} has none of the settings this sends ({', '.join(PUSHED)}).\n"
                 "Make them first: python3 tools/settings.py mail   and/or   python3 tools/comments.py key")
    print(f"Sending to {HOST.split('@')[-1]} (values not shown): {', '.join(send)}")
    fd, tmp = tempfile.mkstemp(prefix="freedom-settings.")   # readable by its owner only
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
            f.write("".join(f"{k}={v}\n" for k, v in send.items()))
        r = subprocess.run(["scp", "-q", *SSH, tmp, f"{HOST}:{REMOTE_NEW}"], capture_output=True, text=True)
    finally:
        os.unlink(tmp)
    if r.returncode:
        sys.exit(f"Could not reach the server ({r.stderr.strip() or 'scp failed'}). Nothing was changed there.")
    code, out = powershell(MERGE)
    if code:
        powershell(r'Remove-Item C:\MigrationTools\freedom-settings.tmp -ErrorAction SilentlyContinue')
        sys.exit(f"The server did not finish: {out}\nIts previous .env, if it was replaced, is C:\\freedom\\env.bak.")
    print(out)
    print("Done. The live server now has these settings.")


def show():
    _, values = read_env()
    print(f"This copy ({ENV}): {', '.join(values) or 'no settings'}")
    code, out = powershell(NAMES)
    print(f"Live server: {', '.join(out.split()) or 'no settings'}" if not code else f"Live server: not reached ({out})")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("what", choices=("mail", "push", "show"))
    what = p.parse_args().what
    try:
        {"mail": mail, "push": push, "show": show}[what]()
    except (KeyboardInterrupt, EOFError):
        sys.exit("\nStopped. Nothing more was changed.")


if __name__ == "__main__":
    main()
