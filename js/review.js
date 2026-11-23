// A small comment icon beside every paragraph (and one per article of quoted law), on every page of the site.
// Pressing it opens a box at the icon for a comment on that text. The comment goes to the editors' queue on the
// server (/api/comment, the same as the speech bubble on a requirement page) with the paragraph's text and where it
// is on the site. On a server with accounts it needs a signed-in reader: a signed-out one gets the sign-in pop-up
// first (Orlin 2026-11-23). On a plain file host, with no server to take comments, there are no icons.
import { t } from './i18n.js';
import { api, account, canSignIn, drawAccount, openAccount, whenSignedIn, ready, page } from './account.js';

{
  const BLOCKS = 'p, li, h1, h2, h3, h4, h5, blockquote, dd, dt, figcaption, td, th';
  const SKIP = '.review-pop, .review-btn, .chat-pop, .notice, button, input, textarea, select, .leaflet-container, .top';

  const textOf = node => {
    const c = node.cloneNode(true);
    c.querySelectorAll('.review-btn').forEach(b => b.remove());
    return c.textContent.replace(/\s+/g, ' ').trim();
  };

  // The headings above the paragraph, from the page title down to the nearest one, e.g. "What is freedom › Families".
  function where(node) {
    const path = [];
    document.querySelectorAll('h1, h2, h3, h4').forEach(h => {
      if (h === node || h.closest(SKIP) || !h.getClientRects().length || !(h.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)) return;   // not a heading that is hidden
      const level = +h.tagName[1];
      while (path.length && path[path.length - 1].level >= level) path.pop();
      path.push({ level, text: textOf(h) });
    });
    return path.map(p => p.text).join(' › ');
  }

  // Paragraphs that hold text of their own: a list item that wraps paragraphs gets no icon, its paragraphs do.
  // An article of quoted law (data-review-unit, with its heading and data-review-part paragraphs): one paragraph gets
  // one icon at the end of its text, for the whole article; two or more get one by the heading, for the article, and
  // one at the end of each paragraph, for that paragraph under its heading.
  const lastLine = part => [...part.querySelectorAll(':scope > p:not(.why):not(.lead)')].pop() || part;
  function mark(root) {
    root.querySelectorAll('[data-review-unit]').forEach(unit => {
      if (unit.dataset.review || unit.closest(SKIP)) return;
      unit.dataset.review = '1';
      const head = unit.querySelector(':scope > [data-review-head]'), parts = unit.querySelectorAll(':scope > [data-review-part]');
      if (parts.length < 2) return icon(lastLine(parts[0] || unit), unit);
      if (head) icon(head, unit);
      parts.forEach(part => icon(lastLine(part), part, head ? textOf(head) : ''));
    });
    root.querySelectorAll(BLOCKS).forEach(node => {
      if (node.dataset.review || node.closest(SKIP) || node.closest('[data-review-unit]') || node.querySelector(BLOCKS) || textOf(node).length < 2) return;
      node.dataset.review = '1';
      icon(node, node);
    });
  }
  function icon(at, node, heading = '') {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'review-btn';
    b.title = t('para.comment');
    b.setAttribute('aria-label', t('para.comment'));
    b.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';
    b.addEventListener('click', e => {
      e.preventDefault(); e.stopPropagation();
      whenSignedIn('signin.toComment', () => open(b), () => remember(b));
    });
    b.reviewOf = { node, heading };
    at.appendChild(b);
  }
  const quoteOf = b => [b.reviewOf.heading, textOf(b.reviewOf.node)].filter(Boolean).join(' ');
  const iconFor = text => [...document.querySelectorAll('.review-btn')].find(b => b.reviewOf && quoteOf(b).slice(0, 300) === text.slice(0, 300));

  // A reader who leaves for Google or Apple to sign in comes back to the same box: the text it was about is kept for
  // this tab (15 minutes), and the box opens again once the page has that text and has stopped changing.
  const DRAFT = 'freedom-para-draft';
  function remember(b) {
    try { sessionStorage.setItem(DRAFT, JSON.stringify({ href: location.href, text: quoteOf(b).slice(0, 300), at: Date.now() })); } catch { /* storage unavailable */ }
  }
  function resume() {
    let d = null;
    try { d = JSON.parse(sessionStorage.getItem(DRAFT) || 'null'); } catch { /* storage unavailable */ }
    if (!d) return false;
    const drop = () => { try { sessionStorage.removeItem(DRAFT); } catch { /* storage unavailable */ } return false; };
    if (d.href !== location.href || Date.now() - d.at > 15 * 60000 || !account.user) return drop();
    const b = iconFor(d.text);
    if (!b) return true;   // not drawn yet: tried again as the page fills
    drop();
    b.scrollIntoView({ block: 'center' });
    open(b);
    return false;
  }

  let pop = null, tidy = null, follow = null;
  function close() { if (pop) { pop.remove(); pop = null; tidy?.(); tidy = follow = null; } }

  // The box opens with a corner at the icon that was pressed (Orlin 2026-11-23), so that it is plain which text the
  // comment is about: its top left corner just under the icon, or, with no room below in the window, its bottom left
  // corner just above it. It is placed on the page, not on the window, so it stays by its icon as the page scrolls,
  // and it is placed again, on the same side, whenever the page around it changes shape.
  function place(at) {
    const r = at.getBoundingClientRect(), view = document.documentElement.clientWidth, h = pop.offsetHeight;
    const below = r.bottom + 4, above = r.top - 4 - h;
    pop.dataset.side ||= below + h <= innerHeight - 8 || above < 8 ? 'below' : 'above';
    pop.style.top = (pop.dataset.side === 'below' ? below : above) + scrollY + 'px';
    pop.style.left = Math.max(8, Math.min(r.left, view - pop.offsetWidth - 8)) + scrollX + 'px';
  }

  // The box stays until Cancel or a successful send: clicks elsewhere, Escape and other icons leave it alone.
  // While it is open its icon is filled in and the text it is about is tinted.
  function open(btn) {
    if (pop) return pop.querySelector('textarea').focus();
    let { node } = btn.reviewOf;
    const text = quoteOf(btn), place_ = where(node);
    pop = document.createElement('div');
    pop.className = 'review-pop';
    pop.innerHTML = '<p class="review-quote"></p><textarea rows="5" maxlength="2000"></textarea>'
      + '<div class="review-row"><span class="review-status" aria-live="polite"></span><button type="button" class="review-cancel"></button>'
      + '<button type="button" class="review-send"></button></div>';
    pop.querySelector('.review-quote').textContent = text.length > 240 ? text.slice(0, 240) + '…' : text;   // shown as two lines at most (css)
    const box = pop.querySelector('textarea'), status = pop.querySelector('.review-status'), send = pop.querySelector('.review-send');
    box.placeholder = t('passage.placeholder'); box.setAttribute('aria-label', t('para.comment'));
    send.textContent = t('chat.send'); pop.querySelector('.review-cancel').textContent = t('para.cancel');
    // A paragraph of the requirement page the map is showing is filed under that page, with its other comments.
    const key = page.key && page.root?.contains(node) ? page.key : '', title = key ? page.title : document.title;
    async function submit() {
      const comment = box.value.trim();
      if (!comment || send.disabled) return box.focus();
      const signIn = () => openAccount({ lead: t('signin.toSend'), onDone: submit });
      if (!account.user && canSignIn()) return signIn();
      send.disabled = true;
      status.textContent = t('passage.sending');
      try {
        const r = await api('POST', 'api/comment', { comment, quote: text.slice(0, 2000), where: place_, page: title, url: location.href, key });
        status.textContent = t('passage.sent');
        node.classList.add('review-done');
        btn.classList.add('done');
        if (r.public && key === page.key) page.refresh?.();
        setTimeout(close, 1500);
      } catch (err) {
        send.disabled = false;
        if (err.status === 401 && canSignIn()) {   // the sign-in ran out, or was ended elsewhere
          account.user = null; drawAccount(); status.textContent = '';
          return signIn();
        }
        status.textContent = { 429: t('passage.tooMany'), 507: t('passage.failed') }[err.status] || (err.refused ? err.message : t('chat.needsServer'));
      }
    }
    send.addEventListener('click', submit);
    pop.querySelector('.review-cancel').addEventListener('click', close);
    box.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
    });
    document.body.appendChild(pop);
    const tint = on => { node.classList.toggle('review-target', on); btn.classList.toggle('open', on); };
    const again = () => { if (pop && btn.isConnected) place(btn); };
    // The map page draws its panels again as it loads: the box then moves to the new icon of the same text.
    follow = () => {
      if (btn.isConnected) return;
      const b = iconFor(text);
      if (!b) return;
      tint(false); btn = b; node = b.reviewOf.node; tint(true); again();
    };
    again(); tint(true);
    addEventListener('resize', again);
    const shape = new ResizeObserver(again);   // the page grew or shrank (a panel was drawn, the map loaded)
    shape.observe(document.body);
    tidy = () => { removeEventListener('resize', again); shape.disconnect(); tint(false); };
    pop.scrollIntoView({ block: 'nearest' });   // only when neither place fits in the window
    box.focus({ preventScroll: true });
  }

  async function start() {
    await ready;
    if (!account.server) return;
    let waiting = true, timer = 0;   // waiting: a box to open again after a trip to Google or Apple
    const draw = () => {
      mark(document.body);
      follow?.();
      if (waiting) { clearTimeout(timer); timer = setTimeout(() => { waiting = resume(); }, 500); }   // once the page is still
    };
    draw();
    let queued = false;  // the map page redraws its panels as you move around, so new paragraphs get icons too
    new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; draw(); });
    }).observe(document.body, { childList: true, subtree: true });
  }

  start();
}
