// Chip colour scheme: "teal" (default: teal = free … dark red = not free), "red" (white = free … dark red = not free)
// or "grey" (white = free … black = not free).
// Kept per browser so the two can be compared by switching back and forth.
(function () {
  let scale = 'teal';
  try { scale = localStorage.getItem('freedom-scale-3') || 'teal'; } catch (e) {}
  document.documentElement.dataset.scale = scale;
  document.addEventListener('DOMContentLoaded', () => {
    const box = document.getElementById('scale');
    if (!box) return;
    const paint = () => box.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.scale === document.documentElement.dataset.scale)));
    box.addEventListener('click', e => {
      const b = e.target.closest('button[data-scale]');
      if (!b) return;
      document.documentElement.dataset.scale = b.dataset.scale;
      try { localStorage.setItem('freedom-scale-3', b.dataset.scale); } catch (err) {}
      paint();
    });
    paint();
  });
})();
