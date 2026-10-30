/**
 * The page's base, under the theme's variables (`theme/`): type, the reset,
 * focus rings, selection and reduced motion, and `copilotz-sr` (for screen
 * readers only). It declares the layers: this base, then the toolkit's
 * pieces (`toolkit/`); a front end's own CSS is in no layer, so it always
 * wins over both.
 */
export const BASE = `
@layer copilotz-base, copilotz-toolkit;
@layer copilotz-base {
:root {
  font: 15px/1.55 var(--font-sans);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  text-rendering: optimizeLegibility;
  -webkit-text-size-adjust: 100%;
  text-size-adjust: 100%;
}
*, *::before, *::after { box-sizing: border-box; }
html, body, #app { height: 100%; }
body { margin: 0; background: var(--background); color: var(--foreground); }
button, input, textarea, select { font: inherit; color: inherit; letter-spacing: inherit; }
a { color: inherit; }
code, kbd, pre, samp { font-family: var(--font-mono); font-variant-ligatures: none; }
:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
::selection { background: color-mix(in oklab, var(--primary-text) 28%, transparent); }
.copilotz-sr { position: absolute !important; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: .01ms !important; animation-iteration-count: 1 !important;
    transition-duration: .01ms !important; scroll-behavior: auto !important; }
}
}
`;
