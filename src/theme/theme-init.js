/**
 * Flash prevention. Stamps the stored theme onto <html> before first paint.
 *
 * Loaded from the <head> of popup.html and settings.html as a plain
 * render-blocking <script src>, ABOVE the stylesheet link. Three properties
 * make that work, and breaking any one of them brings the flash back:
 *
 *   1. It is built as IIFE, not ESM. A `type="module"` script is deferred, so
 *      it would run after first paint — which is the entire problem it solves.
 *      See the css/theme-init esbuild pass in build.mjs.
 *   2. It reads localStorage, which is synchronous. chrome.storage.local is
 *      not, and no amount of ordering fixes an async read.
 *   3. It is a separate file rather than inline, because both manifests set
 *      `script-src 'self'` and an inline script is refused outright.
 *
 * canvas-web solves the same problem with a hand-duplicated inline script in
 * index.html and has to keep its valid-value lists in sync by hand. Ours is
 * bundled, so it imports the real registry and cannot drift.
 */

import { applyTheme, readStoredPreferences } from './apply-theme.js';

applyTheme(readStoredPreferences());

/*
 * Host detection, also before first paint.
 *
 * The popup is fixed-size and the side panel is fluid, so this decides the
 * layout — and it has to be on <html>, not <body>. Chrome sizes an extension
 * popup from the root box; with no width there, it has no definite number to
 * size down to. It also has to happen here rather than in popup.js, which runs
 * at DOMContentLoaded — one paint too late, so the side panel would lay out at
 * the popup's fixed 452px first and then snap to fluid.
 *
 * `?host=panel` is set by side_panel/sidebar_action in the manifests and by
 * sidePanel.setOptions in handleDockClick(). Everything else is the popup.
 */
document.documentElement.dataset.host =
  new URLSearchParams(window.location.search).get('host') === 'panel' ? 'panel' : 'popup';
