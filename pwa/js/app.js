/**
 * App entry: wires prefs, the WS client, the render loop, and the settings UI.
 *
 * Holds the "current snapshot" locally so deltas can be applied incrementally
 * and the elapsed/clock tickers always have fresh state to render.
 */
import { VibeClient } from "./client.js";
import { renderConnState, renderDelta, renderElapsed, renderClock, renderSnapshot, setActiveInstance } from "./render.js";
import { applyPrefs, defaultServerUrl, loadPrefs, savePrefs } from "./settings.js";

// ---- Local snapshot state (deltas applied on top of this) ----
let current = {
  tasks: [],
  task: null,
  narrative: [],
  metrics: [],
};

/** Persist the selected instance + restore it if still present. */
function pinActiveInstance(id) {
  savePrefs({ ...loadPrefs(), activeInstanceId: id });
  setActiveInstance(id);
}

function applySnapshot(snap) {
  current.tasks = snap.tasks ?? (snap.task ? [snap.task] : []);
  current.task = snap.task ?? null;
  current.narrative = snap.narrative ?? [];
  current.metrics = snap.metrics ?? current.metrics;
  renderSnapshot(snap);
  restorePinnedInstance();
  renderElapsed();
}

function applyDelta(delta) {
  if (delta.tasks !== undefined) current.tasks = delta.tasks;
  if (delta.task !== undefined) current.task = delta.task;
  if (delta.narrative !== undefined) current.narrative = delta.narrative;
  if (delta.metrics !== undefined) current.metrics = delta.metrics;
  renderDelta(delta);
  restorePinnedInstance();
  renderElapsed();
}

/** Re-apply the user's pinned instance after a data refresh (if it still exists). */
function restorePinnedInstance() {
  const pinned = loadPrefs().activeInstanceId;
  if (pinned && current.tasks.some((t) => t.id === pinned)) {
    setActiveInstance(pinned);
  }
}

// ---- Boot ----
function boot() {
  const prefs = loadPrefs();
  applyPrefs(prefs);

  const serverUrl = prefs.serverUrl || defaultServerUrl();

  const client = new VibeClient({
    onSnapshot: (snap) => applySnapshot(snap),
    onDelta: (delta) => applyDelta(delta),
    onConnState: (state) => renderConnState(state),
  });
  client.connect(serverUrl);

  // 1s ticker: refresh elapsed + wall clock (cheap; DOM only updates if changed).
  setInterval(() => {
    const now = Date.now();
    renderElapsed(now);
    renderClock(now);
  }, 1000);
  renderClock();

  // Instance selection: delegate clicks on the session list.
  document.getElementById("instanceList")?.addEventListener("click", (e) => {
    const card = e.target.closest(".instance-card");
    if (card?.dataset.id) pinActiveInstance(card.dataset.id);
  });

  // ---- Settings UI wiring ----
  wireSettings(client, prefs);
}

function wireSettings(client, prefs) {
  const overlay = document.getElementById("settingsOverlay");
  const gear = document.getElementById("gearBtn");
  const close = document.getElementById("settingsClose");

  const themeSelect = document.getElementById("themeSelect");
  const fontSelect = document.getElementById("fontSelect");
  const bgSelect = document.getElementById("bgSelect");
  const motionToggle = document.getElementById("reducedMotionToggle");
  const serverInput = document.getElementById("serverInput");
  const reconnectBtn = document.getElementById("reconnectBtn");

  // Initialize control values from prefs.
  themeSelect.value = prefs.theme;
  fontSelect.value = prefs.font;
  bgSelect.value = prefs.background;
  motionToggle.checked = !!prefs.reducedMotion;
  serverInput.value = prefs.serverUrl || defaultServerUrl();

  function open() {
    overlay.hidden = false;
  }
  function hide() {
    overlay.hidden = true;
  }

  gear.addEventListener("click", open);
  close.addEventListener("click", hide);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) hide();
  });

  function commit(patch) {
    const next = { ...loadPrefs(), ...patch };
    prefs = next;
    savePrefs(next);
    applyPrefs(next);
  }

  themeSelect.addEventListener("change", () => commit({ theme: themeSelect.value }));
  fontSelect.addEventListener("change", () => commit({ font: fontSelect.value }));
  bgSelect.addEventListener("change", () => commit({ background: bgSelect.value }));
  motionToggle.addEventListener("change", () => commit({ reducedMotion: motionToggle.checked }));

  serverInput.addEventListener("change", () => commit({ serverUrl: serverInput.value.trim() || null }));
  reconnectBtn.addEventListener("click", () => {
    commit({ serverUrl: serverInput.value.trim() || null });
    client.close();
    // Re-read the (possibly updated) url and reconnect.
    const url = (loadPrefs().serverUrl) || defaultServerUrl();
    client.connect(url);
    hide();
  });

  // Keyboard: Escape closes settings.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !overlay.hidden) hide();
  });
}

// Register the service worker (caches the app shell for offline relaunch).
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => { /* ignore */ });
  });
}

boot();
