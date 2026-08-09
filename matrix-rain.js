// ══════════════════════════════════════════════════════════════════════
// SIGNAL DESK — MATRIX RAIN BACKGROUND (matrix-rain.js)
//
// A subtle, theme-aware digital-rain effect painted behind all page
// content. Self-contained: include <script src="matrix-rain.js"></script>
// on any page and it handles everything — no CSS or HTML changes needed.
//
// Design notes:
//   · Colors are read from the page's CSS variables (--bg, --teal, --amber)
//     so the rain always matches the theme.
//   · Glyphs mix katakana with market symbols ($ % ▲ ▼ digits) — it is a
//     disclosure terminal, after all.
//   · Deliberately faint (content readability wins). Cards and tables have
//     opaque backgrounds, so the rain lives in the page margins and gaps.
//   · Frame-capped at ~30fps, paused when the tab is hidden, and fully
//     disabled for users with prefers-reduced-motion set.
// ══════════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const GLYPHS = 'アイウエオカキクケコサシスセソタチツテトナニヌネノ0123456789$%+▲▼ABCDEFHKLMNPRSTX';
  const FONT_SIZE = 14;        // px
  const FRAME_MS = 33;         // ~30fps
  const FADE_ALPHA = 0.09;     // trail persistence (higher = shorter trails)
  const RAIN_ALPHA = 0.30;     // overall subtlety of the effect
  const HEAD_CHANCE = 0.012;   // odds a column's lead glyph flashes amber
  const RESET_CHANCE = 0.975;  // odds a column keeps falling past the bottom
  const CONTENT_PAD = 28;      // px of clear space beyond the content column
  const EDGE_FADE = 90;        // px over which rain fades in near the content edge

  function cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
    return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
  }

  function init() {
    const bg = cssVar('--bg', '#060706');
    const teal = hexToRgb(cssVar('--teal', '#7ae65a')) || [122, 230, 90];
    const amber = hexToRgb(cssVar('--amber', '#ffc933')) || [255, 201, 51];
    const bgRgb = hexToRgb(bg) || [6, 7, 6];

    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.cssText = 'position:fixed;inset:0;z-index:-1;pointer-events:none;';
    document.body.insertBefore(canvas, document.body.firstChild);

    // Guarantee readability: give the content column and footer a solid
    // page-colored backing so the rain can never show through transparent
    // table rows or card gaps — belt and suspenders alongside the
    // exclusion-zone math below. Visually identical to before (same color),
    // it just stops being see-through.
    const style = document.createElement('style');
    style.textContent = 'main, footer { background: var(--bg, #060706); position: relative; }';
    document.head.appendChild(style);

    // The canvas becomes the page background, so the page itself must be
    // transparent for it to show through. Painting --bg onto the canvas
    // first keeps the visible result identical for any non-rain pixels.
    document.documentElement.style.background = 'transparent';
    document.body.style.background = 'transparent';

    const ctx = canvas.getContext('2d');
    let cols = 0, drops = [], speeds = [];

    // ── content exclusion zone ─────────────────────────────────────────
    // The rain stays OUT of the main content column so data is never read
    // through falling glyphs. Rain lives in the side margins, fading in
    // softly as it moves away from the content edge.
    let exLeft = -1, exRight = -1;
    function measureContent() {
      const el = document.querySelector('main') || document.querySelector('.container');
      if (!el) { exLeft = -1; exRight = -1; return; }
      const r = el.getBoundingClientRect();
      exLeft = r.left - CONTENT_PAD;
      exRight = r.right + CONTENT_PAD;
    }

    // 0 inside the content zone → ramps up to 1 over EDGE_FADE px outside it
    function columnAlpha(x) {
      if (exLeft < 0) return 1;
      if (x >= exLeft && x <= exRight) return 0;
      const dist = x < exLeft ? exLeft - x : x - exRight;
      return Math.min(1, dist / EDGE_FADE);
    }

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(window.innerWidth * dpr);
      canvas.height = Math.floor(window.innerHeight * dpr);
      canvas.style.width = window.innerWidth + 'px';
      canvas.style.height = window.innerHeight + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.font = FONT_SIZE + "px 'IBM Plex Mono', monospace";

      const newCols = Math.ceil(window.innerWidth / FONT_SIZE);
      // preserve existing columns on resize; seed new ones at random heights
      for (let i = cols; i < newCols; i++) {
        drops[i] = Math.random() * (window.innerHeight / FONT_SIZE);
        speeds[i] = 0.6 + Math.random() * 0.8; // varied fall speeds
      }
      cols = newCols;

      // opaque base coat so the first frames aren't transparent-black
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);
    }

    let last = 0, running = true;

    function frame(now) {
      requestAnimationFrame(frame);
      if (!running || now - last < FRAME_MS) return;
      last = now;

      // translucent bg-colored wash = the classic fading-trail trick
      ctx.fillStyle = `rgba(${bgRgb[0]},${bgRgb[1]},${bgRgb[2]},${FADE_ALPHA})`;
      ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);

      for (let i = 0; i < cols; i++) {
        const x = i * FONT_SIZE;
        const a = columnAlpha(x);
        if (a <= 0) continue; // inside the content column — leave it clean

        const ch = GLYPHS[(Math.random() * GLYPHS.length) | 0];
        const y = drops[i] * FONT_SIZE;

        if (Math.random() < HEAD_CHANCE) {
          // occasional amber flash — a "tick" in the tape
          ctx.fillStyle = `rgba(${amber[0]},${amber[1]},${amber[2]},${(RAIN_ALPHA + 0.15) * a})`;
        } else {
          ctx.fillStyle = `rgba(${teal[0]},${teal[1]},${teal[2]},${RAIN_ALPHA * a})`;
        }
        ctx.fillText(ch, x, y);

        if (y > window.innerHeight && Math.random() > RESET_CHANCE) drops[i] = 0;
        else drops[i] += speeds[i];
      }
    }

    document.addEventListener('visibilitychange', () => { running = !document.hidden; });
    window.addEventListener('resize', () => { resize(); measureContent(); });
    resize();
    measureContent();
    requestAnimationFrame(frame);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
