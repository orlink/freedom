// Chip colour scheme: "grey" (white = free … black = not free) or "red" (dark red = free … palest = not free).
// Kept per browser so the two can be compared by switching back and forth.
(function () {
  let scale = 'grey';
  try { scale = localStorage.getItem('freedom-scale') || 'grey'; } catch (e) {}
  document.documentElement.dataset.scale = scale;
  document.addEventListener('DOMContentLoaded', () => {
    const box = document.getElementById('scale');
    if (!box) return;
    const paint = () => box.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.scale === document.documentElement.dataset.scale)));
    box.addEventListener('click', e => {
      const b = e.target.closest('button[data-scale]');
      if (!b) return;
      document.documentElement.dataset.scale = b.dataset.scale;
      try { localStorage.setItem('freedom-scale', b.dataset.scale); } catch (err) {}
      paint();
    });
    paint();
  });
})();
