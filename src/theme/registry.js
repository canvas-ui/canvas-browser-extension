/**
 * Theme registry — the single source of truth for which themes exist.
 *
 * Port of canvas-web's src/theme/registry.ts. The storage key and the stored
 * JSON shape are deliberately identical to the web app's: this costs nothing
 * today, and when the pnpm monorepo turns the theme layer into a shared
 * package, adopting it is a delete rather than a data migration.
 *
 * A theme is registered here and defined in ./theme.css (generated from
 * canvas-web — see scripts/sync-theme.mjs). Nothing else in the extension
 * enumerates themes, so the Appearance picker cannot drift from what the CSS
 * actually supports.
 */

/**
 * Registered themes. `swatches` are for the picker's preview chips only —
 * presentation, not part of the theming contract.
 */
export const THEMES = [
  {
    id: 'canvas',
    name: 'Canvas',
    description: 'Black and white with a teal accent.',
    swatches: ['oklch(1 0 0)', 'oklch(0 0 0)', 'oklch(0.704 0.135 183)']
  },
  {
    id: 'nord',
    name: 'Nord',
    description: 'Cool arctic blues, lower contrast, softer corners.',
    swatches: ['oklch(0.976 0.006 251)', 'oklch(0.588 0.056 244)', 'oklch(0.686 0.062 213)']
  },
  {
    id: 'contrast',
    name: 'High Contrast',
    description: 'WCAG AAA text contrast, square corners, hard borders.',
    swatches: ['oklch(1 0 0)', 'oklch(0 0 0)', 'oklch(0.32 0.16 258)']
  },
  {
    id: 'terminal',
    name: 'Terminal',
    description: 'Monospaced and dense. Tighter rows and chrome.',
    swatches: ['oklch(0.17 0.006 152)', 'oklch(0.8 0.19 148)', 'oklch(0.75 0.12 220)']
  }
];

export const THEME_IDS = THEMES.map((t) => t.id);

export const SCHEME_OPTIONS = [
  { id: 'system', name: 'System' },
  { id: 'light', name: 'Light' },
  { id: 'dark', name: 'Dark' }
];

export const DENSITY_OPTIONS = [
  { id: 'auto', name: 'Auto', description: 'Match the pointer' },
  { id: 'compact', name: 'Compact', description: 'Maximum rows per screen' },
  { id: 'comfortable', name: 'Comfortable', description: 'Balanced for mouse use' },
  { id: 'touch', name: 'Touch', description: 'Large targets for finger input' }
];

/**
 * Defaults.
 *
 * 'light', not 'system' — same reasoning as the web app: Canvas is a document
 * surface and its light theme is the designed-for-first one. Choosing dark, or
 * choosing to follow the OS, is an opt-in that is then stored and wins.
 *
 * Density defaults to 'auto', which lets the CSS pick from pointer type. The
 * popup is a desktop surface, but the side panel on a 2-in-1 is not.
 */
export const DEFAULT_PREFERENCES = {
  theme: 'canvas',
  scheme: 'light',
  density: 'auto'
};

/** Storage key. Namespaced, and shared verbatim with the web app. */
export const THEME_STORAGE_KEY = 'canvas.ui.theme';

export function isThemeId(value) {
  return typeof value === 'string' && THEME_IDS.includes(value);
}

export function isSchemePreference(value) {
  return value === 'light' || value === 'dark' || value === 'system';
}

export function isDensity(value) {
  return value === 'auto' || value === 'compact' || value === 'comfortable' || value === 'touch';
}

/**
 * Coerce untrusted input into a valid preference set.
 *
 * Stored preferences are untrusted: the key is user-editable and it outlives
 * the code that wrote it — a theme removed in a later release will still be in
 * someone's storage. Each field falls back independently so one stale value
 * does not discard the rest.
 */
export function normalizePreferences(input) {
  const raw = typeof input === 'object' && input !== null ? input : {};
  return {
    theme: isThemeId(raw.theme) ? raw.theme : DEFAULT_PREFERENCES.theme,
    scheme: isSchemePreference(raw.scheme) ? raw.scheme : DEFAULT_PREFERENCES.scheme,
    density: isDensity(raw.density) ? raw.density : DEFAULT_PREFERENCES.density
  };
}
