// The owner's text review, on the local copy only (server.py --edit): a small comment icon beside every paragraph
// (and one per article of quoted law).
// A comment is sent to /api/review together with the paragraph's text and where it is on the site, and the server
// appends it to data/state/review.jsonl, which Claude watches and answers. On any other server /api/editor says
// false (or does not exist), so nothing here runs.
(function () {
  const BLOCKS = 'p, li, h1, h2, h3, h4, h5, blockquote, dd, dt, figcaption, td, th';
  const SKIP = '.review-pop, .review-btn, .chat-pop, button, input, textarea, select, .leaflet-container, .top';

  const textOf = node => {
    const c = node.cloneNode(true);
    c.querySelectorAll('.review-btn').forEach(b => b.remove());
    return c.textContent.replace(/\s+/g, ' ').trim();
  };

  // The headings above the paragraph, from the page title down to the nearest one, e.g. "What is freedom › Families".
  function where(node) {
    const path = [];
    document.querySelectorAll('h1, h2, h3, h4').forEach(h => {
      if (h === node || h.closest(SKIP) || !(h.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)) return;
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
    b.title = 'Comment on this text';
    b.setAttribute('aria-label', 'Comment on this text');
    b.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';
    b.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); open(node, heading, b); });
    at.appendChild(b);
  }

  let pop = null;
  function close() { if (pop) { pop.remove(); pop = null; } }

  // The box stays until Cancel or a successful send: clicks elsewhere, Escape and other icons leave it alone.
  function open(node, heading = '', btn = null) {
    if (pop) return pop.querySelector('textarea').focus();
    const text = [heading, textOf(node)].filter(Boolean).join(' ');
    pop = document.createElement('div');
    pop.className = 'review-pop';
    pop.innerHTML = '<p class="review-quote"></p><textarea rows="5" placeholder="Your comment (⌘/Ctrl+Enter sends)"></textarea>'
      + '<div class="review-row"><span class="review-status"></span><button type="button" class="review-cancel">Cancel</button>'
      + '<button type="button" class="review-send">Send</button></div>';
    pop.querySelector('.review-quote').textContent = text.length > 240 ? text.slice(0, 240) + '…' : text;
    const box = pop.querySelector('textarea'), status = pop.querySelector('.review-status'), send = pop.querySelector('.review-send');
    async function submit() {
      const comment = box.value.trim();
      if (!comment) return box.focus();
      send.disabled = true;
      status.textContent = 'Sending…';
      try {
        const r = await fetch('api/review', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ comment, text, where: where(node), page: document.title, url: location.href }) });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status);
        status.textContent = 'Sent.';
        node.classList.add('review-done');
        btn?.classList.add('done');
        setTimeout(close, 1500);
      } catch (e) {
        status.textContent = 'Not sent: ' + e.message;
        send.disabled = false;
      }
    }
    send.addEventListener('click', submit);
    pop.querySelector('.review-cancel').addEventListener('click', close);
    box.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
    });
    document.body.appendChild(pop);
    const r = node.getBoundingClientRect();
    pop.style.top = Math.max(8, Math.min(r.bottom + 6, innerHeight - pop.offsetHeight - 8)) + 'px';
    pop.style.left = Math.max(8, Math.min(r.left, innerWidth - pop.offsetWidth - 8)) + 'px';
    box.focus();
  }

  async function start() {
    const on = await fetch('api/editor').then(r => r.json()).then(r => r.editor === true, () => false);
    if (!on) return;
    mark(document.body);
    let queued = false;  // the map page redraws its panels as you move around, so new paragraphs get icons too
    new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; mark(document.body); });
    }).observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
