/**
 * Render: snapshot/delta -> DOM.
 *
 * Pure DOM manipulation against the elements in index.html. Kept free of state
 * so it's trivially testable from Playwright (it only reads DOM attributes/text).
 */

const STATUS_WORDS = {
  idle: "IDLE",
  running: "RUNNING",
  waiting: "WAITING",
  failed: "FAILED",
  completed: "DONE",
  observed: "OBSERVED",
};

/** Cache of metric keys -> elements, so we update in place instead of rebuilding. */
let cardCache = new Map();

/** Render a full snapshot. */
export function renderSnapshot(snap) {
  renderTask(snap.task);
  renderMetrics(snap.metrics || []);
}

/** Apply a partial delta on top of the last snapshot. */
export function renderDelta(delta) {
  if (delta.task !== undefined) renderTask(delta.task);
  if (delta.metrics !== undefined) renderMetrics(delta.metrics);
}

function renderTask(task) {
  const dot = document.getElementById("statusDot");
  const word = document.getElementById("statusWord");
  const label = document.getElementById("taskLabel");
  const cwd = document.getElementById("taskCwd");

  const status = task ? task.status : "idle";
  if (dot) dot.dataset.status = status;
  if (word) word.textContent = STATUS_WORDS[status] || status.toUpperCase();

  if (task && (task.label || task.cwdLabel)) {
    if (label) {
      label.textContent = task.label || task.cwdLabel || "—";
      label.title = task.label || "";
    }
    if (cwd) cwd.textContent = task.cwdLabel && task.cwdLabel !== task.label ? task.cwdLabel : "";
  } else {
    if (label) label.textContent = "waiting for a task…";
    if (cwd) cwd.textContent = "";
  }

  // Elapsed is updated separately by a 1s ticker in app.js.
}

function renderMetrics(metrics) {
  const grid = document.getElementById("quotaGrid");
  if (!grid) return;

  const seen = new Set();
  for (const m of metrics) {
    seen.add(m.key);
    let card = cardCache.get(m.key);
    if (!card) {
      card = buildCard(m);
      grid.appendChild(card.el);
      cardCache.set(m.key, card);
    }
    updateCard(card, m);
  }
  // Remove cards no longer present.
  for (const [key, card] of cardCache.entries()) {
    if (!seen.has(key)) {
      card.el.remove();
      cardCache.delete(key);
    }
  }
}

function buildCard(m) {
  const el = document.createElement("div");
  el.className = "quota-card with-bar";
  el.dataset.key = m.key;

  const label = document.createElement("div");
  label.className = "quota-label";
  label.textContent = m.label;

  const value = document.createElement("div");
  value.className = "quota-value";

  const reset = document.createElement("div");
  reset.className = "quota-reset";

  const bar = document.createElement("div");
  bar.className = "quota-bar";
  const fill = document.createElement("div");
  fill.className = "quota-bar-fill";
  bar.appendChild(fill);

  el.append(label, value, reset, bar);
  return { el, label, value, reset, bar, fill };
}

function updateCard(card, m) {
  card.label.textContent = m.label;
  card.value.textContent = m.valueText ?? "--";
  card.value.className = `quota-value ${m.quotaClass || ""}`.trim();

  if (m.resetText) {
    card.reset.textContent = m.resetText;
    card.reset.style.display = "";
  } else {
    card.reset.textContent = "";
    card.reset.style.display = "none";
  }

  const pct = typeof m.progressPercent === "number" ? Math.max(0, Math.min(100, m.progressPercent)) : 0;
  card.fill.style.width = `${pct}%`;
  card.fill.className = `quota-bar-fill ${m.quotaClass || ""}`.trim();
}

/** Update the hero elapsed clock from the task's startedAt. */
export function renderElapsed(task, now = Date.now()) {
  const el = document.getElementById("taskElapsed");
  if (!el) return;
  if (!task || !task.startedAt) {
    el.textContent = "00:00";
    return;
  }
  const secs = Math.max(0, Math.floor((now - task.startedAt) / 1000));
  const h = Math.floor(secs / 3600);
  const mm = String(Math.floor((secs % 3600) / 60)).padStart(2, "0");
  const ss = String(secs % 60).padStart(2, "0");
  el.textContent = h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Update the wall clock. */
export function renderClock(now = Date.now()) {
  const el = document.getElementById("clock");
  if (!el) return;
  const d = new Date(now);
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  el.textContent = `${hh}:${mi}`;
}

/** Update the connection badge. */
export function renderConnState(state) {
  const el = document.getElementById("connBadge");
  if (!el) return;
  el.dataset.conn = state; // connecting | open | closed
}
