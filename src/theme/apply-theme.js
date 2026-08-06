/**
 * Theme application — the DOM seam.
 *
 * Port of canvas-web's src/theme/apply-theme.ts, minus the SSR guards and the
 * useSyncExternalStore adapters (no React here). Touches `document` and
 * `localStorage` and nothing else — no extension APIs, so it is equally usable
 * from the popup, the side panel and the settings page.
 *
 * All state lives on <html> as data attributes, which is what ./theme.css
 * selects on. There is no JavaScript-held copy of the theme that could
 * disagree with what is rendered.
 *
 * ── Why localStorage and not chrome.storage.local ───────────────────────────
 *
 * Every extension page shares one chrome-extension://<id> origin, so popup,
 * side panel and settings already see the same localStorage — and it is
 * synchronous, which storage.local is not. That matters: ./theme-init.js has
 * to stamp the attributes *before first paint*, and an async read cannot. The
 * service worker cannot reach localStorage, but it has no use for a
 * presentation preference.
 *
 * The `storage` event fires in other same-origin documents, which is how a
 * docked side panel restyles live while you change the theme in settings.
 */

import { DEFAULT_PREFERENCES, THEME_STORAGE_KEY, normalizePreferences } from './registry.js';

const DARK_QUERY = '(prefers-color-scheme: dark)';

export function prefersDark() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(DARK_QUERY).matches;
}

/** Collapse a preference to the scheme the CSS should actually render. */
export function resolveScheme(preference) {
  if (preference === 'system') return prefersDark() ? 'dark' : 'light';
  return preference;
}

/**
 * Subscribe to OS scheme changes. Returns an unsubscribe function.
 *
 * Callers should only act on this while the preference is 'system'; the
 * listener itself stays attached either way, since attaching and detaching on
 * every preference change is more code than ignoring an event.
 */
export function watchSystemScheme(onChange) {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const query = window.matchMedia(DARK_QUERY);
  const handler = (event) => onChange(event.matches ? 'dark' : 'light');
  query.addEventListener('change', handler);
  return () => query.removeEventListener('change', handler);
}

/**
 * Write the resolved theme to the DOM. Returns the resolved scheme so callers
 * don't have to re-derive it.
 */
export function applyTheme(preferences, root = document.documentElement) {
  const resolved = resolveScheme(preferences.scheme);
  if (!root) return resolved;

  root.dataset.theme = preferences.theme;
  root.dataset.scheme = resolved;
  root.dataset.density = preferences.density;

  return resolved;
}

/**
 * Suppress transitions for the duration of a theme switch.
 *
 * Without this, changing theme animates every transition-bearing element at
 * once — a slow, smeared repaint that reads as jank rather than polish. In the
 * popup that is unusually visible, because the whole 300%-wide view container
 * carries a transform transition.
 *
 * The forced reflow between adding and removing the style element is required:
 * it flushes the change so the browser cannot batch both mutations into one
 * frame.
 */
export function applyThemeWithoutTransition(preferences, root = document.documentElement) {
  if (!root || typeof window === 'undefined') return applyTheme(preferences, root);

  const style = document.createElement('style');
  style.appendChild(
    document.createTextNode('*,*::before,*::after{transition:none!important;animation:none!important}')
  );
  document.head.appendChild(style);

  const resolved = applyTheme(preferences, root);

  void window.getComputedStyle(style).opacity;
  document.head.removeChild(style);

  return resolved;
}

export function readStoredPreferences() {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    return raw ? normalizePreferences(JSON.parse(raw)) : DEFAULT_PREFERENCES;
  } catch {
    // Malformed JSON, or storage blocked. Neither is worth failing a render
    // over — an unthemed-but-correct render beats a blank popup.
    return DEFAULT_PREFERENCES;
  }
}

export function writeStoredPreferences(preferences) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // Quota or a locked-down profile. The theme still applies for this
    // session; it just won't be remembered.
  }
}

export function clearStoredPreferences() {
  try {
    localStorage.removeItem(THEME_STORAGE_KEY);
  } catch {
    /* see writeStoredPreferences */
  }
}

/**
 * Read, apply and persist in one step. The common case for a picker: every
 * control passes the field it owns and inherits the rest.
 */
export function updateTheme(patch) {
  const next = normalizePreferences({ ...readStoredPreferences(), ...patch });
  writeStoredPreferences(next);
  applyThemeWithoutTransition(next);
  return next;
}

/**
 * Re-apply whenever another extension page changes the preference, or — while
 * the preference is 'system' — whenever the OS flips. Returns an unsubscribe.
 *
 * `onChange` receives the new preferences; pass one if the caller renders its
 * own controls and needs to keep them in step.
 */
export function watchTheme(onChange = () => {}) {
  const handleStorage = (event) => {
    // `key === null` is a whole-store clear, which should also be honoured.
    if (event.key !== null && event.key !== THEME_STORAGE_KEY) return;
    const next = readStoredPreferences();
    applyThemeWithoutTransition(next);
    onChange(next);
  };

  window.addEventListener('storage', handleStorage);
  const unwatchSystem = watchSystemScheme(() => {
    const current = readStoredPreferences();
    if (current.scheme !== 'system') return;
    applyTheme(current);
    onChange(current);
  });

  return () => {
    window.removeEventListener('storage', handleStorage);
    unwatchSystem();
  };
}
