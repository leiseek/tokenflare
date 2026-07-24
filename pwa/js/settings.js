/**
 * Settings: theme/font/background/reduced-motion/server persistence + application.
 *
 * Display preferences live in localStorage on the phone. The server URL is also
 * stored here (default derived from the page's origin). No data is sent anywhere.
 */

const STORAGE_KEY = "tokenflare.prefs.v1";

const FONTS = {
  jetbrains: "https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&display=swap",
  inter: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;700&display=swap",
  system: null, // system font needs no stylesheet
};

const DEFAULT_PREFS = {
  theme: "neon-dark",
  font: "jetbrains",
  background: "mesh",
  reducedMotion: false,
  serverUrl: null, // derived from origin if null
};

/** Load prefs from localStorage, merged over defaults. */
export function loadPrefs() {
  let stored = {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) stored = JSON.parse(raw);
  } catch { /* ignore */ }
  return { ...DEFAULT_PREFS, ...stored };
}

/** Persist prefs. */
export function savePrefs(prefs) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch { /* ignore */ }
}

/** Derive the default ws URL from the page origin. */
export function defaultServerUrl() {
  const loc = window.location;
  if (loc.protocol === "file:") return "ws://127.0.0.1:7331/ws";
  const wsProto = loc.protocol === "https:" ? "wss:" : "ws:";
  return `${wsProto}//${loc.host}/ws`;
}

/** Apply prefs to the DOM (<html> data attributes + font stylesheet). */
export function applyPrefs(prefs) {
  const root = document.documentElement;
  root.dataset.theme = prefs.theme;
  root.dataset.font = prefs.font;
  root.dataset.bg = prefs.background;
  root.dataset.reducedMotion = String(!!prefs.reducedMotion);

  const link = document.getElementById("fontLink");
  if (link) {
    const href = FONTS[prefs.font];
    if (href) {
      if (link.getAttribute("href") !== href) link.setAttribute("href", href);
      link.disabled = false;
    } else {
      // System font: disable the Google Fonts sheet entirely.
      link.disabled = true;
    }
  }
}
