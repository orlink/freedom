// Signing in, and the few helpers every page's scripts share. Loaded by the map (app.js) and by the comment icons
// beside paragraphs (review.js), so the round account button and the sign-in pop-up work on every page of the site.
import { t } from './i18n.js';

export const el = (tag, attrs = {}, ...children) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) n.append(c.nodeType ? c : document.createTextNode(c));
  return n;
};

// A server that answers with its own JSON error (a limit was reached, bad input) is `refused`: the change was not made,
// but the server is there, so the page keeps using it. Anything else (no server.py, network down) is not.
export async function api(method, path, body) {
  const r = await fetch(path, method === 'GET' ? {} : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = (r.headers.get('content-type') || '').includes('json');
  if (!r.ok) {
    const msg = json ? (await r.json().catch(() => ({}))).error : null;
    throw Object.assign(new Error(msg || String(r.status)), { status: r.status, refused: Boolean(msg) });
  }
  if (!json) throw new Error(r.status);
  return r.json();
}
// A short message at the bottom of the screen, e.g. when the server refuses a change.
export function notice(text) {
  let box = document.getElementById('notice');
  if (!box) { box = el('div', { id: 'notice', class: 'notice', role: 'status' }); document.body.append(box); }
  box.textContent = text;
  box.classList.add('on');
  clearTimeout(notice.timer);
  notice.timer = setTimeout(() => box.classList.remove('on'), 6000);
}

// ---------- signing in ----------
// A reader signs in with a code sent to their email address, with Google or with Apple (accounts.py), each only where
// the server offers it. The sign-in itself is a cookie the page's scripts cannot read; `account` is what the page
// knows: who is signed in and which ways the server offers. On a server with accounts, sending a comment needs it.
// shown: which comments other readers see (server.py, COMMENTS_SHOWN). server: the site's own server answered
// (false on a plain file host, where nothing can be sent).
export const account = { user: null, methods: {}, shown: 'own', server: false };
export const canSignIn = () => Object.values(account.methods).some(Boolean);
const ICON_PERSON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8.2" r="3.8"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/></svg>';
// The two providers' own marks, unaltered, as their rules for sign-in buttons ask (Google's four-colour "G", Apple's
// logo in black on a white button).
const PROVIDER_LOGO = {
  google: '<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>',
  apple: '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path fill="#000" d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701"/></svg>',
};
const accountUi = { btn: null, pop: null };
// Called whenever the reader signs in or out (and once when the page first learns who they are).
const listeners = [];
export const onAccount = fn => { listeners.push(fn); };
export function closeAccount() { accountUi.pop?.remove(); accountUi.pop = null; accountUi.btn?.setAttribute('aria-expanded', 'false'); }
// The round button at the far right of the header: an outline while signed out, filled once signed in.
// It is not there at all on a server without accounts.
export function drawAccount() {
  if (!accountUi.btn) {
    accountUi.btn = el('button', { type: 'button', class: 'account-btn', 'aria-expanded': 'false', onclick: () => (accountUi.pop ? closeAccount() : openAccount()) });
    accountUi.btn.innerHTML = ICON_PERSON;
    document.querySelector('.top')?.append(accountUi.btn);
  }
  const label = account.user ? t('account.signedIn', { who: account.user.email || account.user.name }) : t('account.signIn');
  accountUi.btn.hidden = !account.user && !canSignIn();
  accountUi.btn.classList.toggle('in', Boolean(account.user));
  accountUi.btn.title = label; accountUi.btn.setAttribute('aria-label', label);
  for (const fn of listeners) fn();
}
export function openAccount({ lead, onDone, beforeLeave } = {}) {
  closeAccount();
  const head = title => el('div', { class: 'chat-head' }, el('strong', {}, title), el('button', { type: 'button', class: 'chat-close', 'aria-label': t('chat.close'), onclick: closeAccount }, '×'));
  let body;
  if (!account.user) body = signInPanel({ lead, beforeLeave, onDone: () => { closeAccount(); onDone?.(); } });
  else {
    const status = el('p', { class: 'chat-error', 'aria-live': 'polite' });
    const leave = async (path, done) => {
      try { await api('POST', path, {}); } catch { status.textContent = t('signin.failed'); return; }
      account.user = null; drawAccount(); closeAccount();
      if (done) notice(done);
    };
    const del = el('button', { type: 'button', class: 'link', onclick: () => {
      // Asked twice, in place: the first press only shows what deleting means.
      if (del.dataset.sure) return leave('api/auth/delete', t('account.deleted'));
      del.dataset.sure = '1'; del.textContent = t('account.deleteYes'); status.textContent = t('account.deleteSure');
    } }, t('account.delete'));
    // The name other signed-in readers see beside this reader's comments (Google or Apple may have given one).
    const name = el('input', { type: 'text', name: 'name', autocomplete: 'nickname', maxlength: '60', placeholder: t('account.name'), 'aria-label': t('account.name') });
    name.value = account.user.name || '';
    const save = el('button', { type: 'submit', class: 'chat-send' }, t('account.save'));
    const nameForm = el('form', { onsubmit: async e => {
      e.preventDefault();
      save.disabled = true;
      try {
        account.user = (await api('POST', 'api/auth/name', { name: name.value })).user; drawAccount();
        name.value = account.user.name; status.className = 'chat-intro'; status.textContent = t('account.saved');
      } catch { status.className = 'chat-error'; status.textContent = t('signin.failed'); }
      save.disabled = false;
    } }, name, save);
    body = el('div', { class: 'signin' },
      el('p', { class: 'chat-intro' }, t('account.signedIn', { who: account.user.email || account.user.name })),
      nameForm,
      el('button', { type: 'button', class: 'signin-btn', onclick: () => leave('api/auth/signout') }, t('account.signOut')),
      status, del);
  }
  const pop = el('div', { class: 'chat-pop account-pop', role: 'dialog', 'aria-label': t(account.user ? 'account.title' : 'account.signIn') },
    head(t(account.user ? 'account.title' : 'account.signIn')), body);
  pop.addEventListener('keydown', e => { if (e.key === 'Escape') { closeAccount(); accountUi.btn.focus(); } });
  accountUi.pop = pop;
  document.body.append(pop);
  accountUi.btn.setAttribute('aria-expanded', 'true');
  if (!matchMedia('(max-width: 600px)').matches) {   // under the button; on a phone the pop-up sits at the bottom
    const r = accountUi.btn.getBoundingClientRect(), w = pop.offsetWidth, view = document.documentElement.clientWidth;
    Object.assign(pop.style, { top: `${r.bottom + 8}px`, left: `${Math.max(8, Math.min(r.left, view - w - 8))}px`, right: 'auto' });
  }
  (pop.querySelector('input, .signin-btn') || pop.querySelector('button')).focus();
}
// Commenting and the chat are for signed-in readers (on a server with accounts). A signed-out reader who presses one
// of their icons gets the sign-in pop-up first, with a line saying why; what they pressed opens once they are in
// (Orlin 2026-11-23). remember: called before a trip to Google or Apple, so that it opens again on the way back.
export function whenSignedIn(why, then, remember) {
  if (account.user || !canSignIn()) return then();
  openAccount({ lead: t(why), onDone: then, beforeLeave: remember });
}
// The ways to sign in, as one block: Google and Apple (a trip to their site and back to this page), and an email
// address that gets a six-digit code. lead: a line above them. onDone: called once signed in, without leaving the
// page (email). beforeLeave: called before a trip to Google or Apple, to keep what the reader was writing.
export function signInPanel({ lead, onDone, beforeLeave } = {}) {
  const status = el('p', { class: 'chat-error', 'aria-live': 'polite' });
  const say = (text, bad = true) => { status.className = bad ? 'chat-error' : 'chat-intro'; status.textContent = text; };
  const fail = err => say({ 429: t('signin.tooMany'), 502: t('signin.mailFailed') }[err.status] || (err.status === 400 ? null : t('signin.failed')));
  const trip = provider => {
    const logo = el('span', { class: 'signin-logo' });
    logo.innerHTML = PROVIDER_LOGO[provider];
    return el('button', { type: 'button', class: 'signin-btn', onclick: () => {
      beforeLeave?.();
      location.href = `api/auth/start/${provider}?return=${encodeURIComponent(location.pathname + location.search + location.hash)}`;
    } }, logo, t(`signin.${provider}`));
  };
  const email = el('input', { type: 'email', name: 'email', autocomplete: 'email', placeholder: t('signin.email'), 'aria-label': t('signin.email'), maxlength: '254', required: '' });
  const code = el('input', { type: 'text', name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', placeholder: t('signin.code'), 'aria-label': t('signin.code'), maxlength: '7', required: '' });
  const ask = el('button', { type: 'submit', class: 'chat-send' }, t('signin.sendCode'));
  const enter = el('button', { type: 'submit', class: 'chat-send' }, t('account.signIn'));
  const again = el('button', { type: 'button', class: 'link', onclick: () => { codeForm.hidden = again.hidden = true; emailForm.hidden = false; say(''); email.focus(); } }, t('signin.otherEmail'));
  const emailForm = el('form', { onsubmit: async e => {
    e.preventDefault();
    if (ask.disabled) return;
    ask.disabled = true; say(t('passage.sending'), false);
    try {
      await api('POST', 'api/auth/email', { email: email.value });
      emailForm.hidden = true; codeForm.hidden = again.hidden = false;
      say(t('signin.codeSent', { email: email.value.trim() }), false);
      code.value = ''; code.focus();
    } catch (err) { fail(err); if (err.status === 400) say(t('signin.badEmail')); }
    ask.disabled = false;
  } }, email, ask);
  const codeForm = el('form', { hidden: '', onsubmit: async e => {
    e.preventDefault();
    if (enter.disabled) return;
    enter.disabled = true;
    try {
      const r = await api('POST', 'api/auth/email/verify', { email: email.value, code: code.value });
      account.user = r.user; drawAccount();
      onDone?.();
    } catch (err) { fail(err); if (err.status === 400) { say(t('signin.badCode')); code.select(); } }
    enter.disabled = false;
  } }, code, enter);
  again.hidden = true;
  const m = account.methods;
  return el('div', { class: 'signin' },
    lead ? el('p', { class: 'chat-intro' }, lead) : null,
    m.google ? trip('google') : null, m.apple ? trip('apple') : null,
    m.email ? emailForm : null, m.email ? codeForm : null, status, m.email ? again : null,
    el('p', { class: 'signin-note' }, t('signin.privacy')));
}

// The requirement page the map is showing, if any (set by app.js): its comment key, its name, the part of the page
// that is about it, and a way to load its comments again. review.js files a paragraph comment under it.
export const page = { key: '', title: '', root: null, refresh: null };

// Settled once the page knows who is signed in and which ways to sign in the server offers.
export const ready = api('GET', 'api/me').then(r => { account.server = true; account.user = r.user || null; account.methods = r.methods || {}; account.shown = r.comments || 'own'; }, () => {}).then(() => {
  drawAccount();
  if (/(^|;\s*)fm_signin=failed/.test(document.cookie)) {   // a trip to Google or Apple that did not work (server.py)
    document.cookie = 'fm_signin=; Path=/; Max-Age=0';
    notice(t('signin.failed'));
  }
});
