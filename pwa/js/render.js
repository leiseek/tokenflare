/**
 * Render: snapshot/delta -> DOM.
 *
 * Pure DOM manipulation against the elements in index.html. Kept free of state
 * so it's trivially testable from Playwright (it only reads DOM attributes/text).
 *
 * Multi-instance model: the left rail shows one card per active session
 * (each tool/instance has its own project name + status); the progress panel
 * shows ONLY the selected instance's latest narrative.
 */

const STATUS_WORDS = {
  idle: "IDLE",
  running: "RUNNING",
  waiting: "WAITING",
  failed: "FAILED",
  completed: "DONE",
  observed: "OBSERVED",
};

const PROVIDER_LABEL = { codex: "CODEX", claude: "CLAUDE", manual: "MANUAL" };

/** Cache of metric keys -> elements, so we update in place instead of rebuilding. */
let cardCache = new Map();
/** Latest tasks array (snapshot applied incrementally). */
let tasks = [];
/** Flat narrative list (one entry per instance). */
let narrativeEntries = [];
/** Currently selected instance id (null = most-active). */
let activeInstanceId = null;
/** Last known per-provider quota source, so empty sections can explain why. */
let lastSources = null;
/** Last rendered metrics, so a source-only delta can re-render without them. */
let lastMetrics = [];

/** Render a full snapshot. */
export function renderSnapshot(snap) {
  tasks = snap.tasks || (snap.task ? [taskToInstance(snap.task)] : []);
  narrativeEntries = snap.narrative || [];
  renderInstances(tasks);
  renderActiveDetail();
  renderNarrative(narrativeEntries);
  renderMetrics(snap.metrics || [], snap.source);
}

/** Apply a partial delta on top of the last snapshot. */
export function renderDelta(delta) {
  if (delta.tasks !== undefined) {
    tasks = delta.tasks;
    renderInstances(tasks);
    renderActiveDetail();
  } else if (delta.task !== undefined) {
    // Legacy single-task delta: refresh active detail only.
    renderActiveDetail();
  }
  if (delta.narrative !== undefined) {
    narrativeEntries = delta.narrative;
    renderNarrative(narrativeEntries);
  }
  // A source-only delta still matters: it flips an empty section between
  // "not connected" and "no windows reported".
  if (delta.metrics !== undefined || delta.source !== undefined) {
    renderMetrics(delta.metrics ?? lastMetrics, delta.source);
  }
}

/** Convert a legacy TaskState to a minimal instance shape. */
function taskToInstance(task) {
  return {
    id: `${task.provider}:${task.taskId}`,
    taskId: task.taskId,
    provider: task.provider,
    cwdLabel: task.cwdLabel,
    label: task.label,
    status: task.status,
    startedAt: task.startedAt,
    lastActivityAt: task.lastActivityAt,
    lastNarrative: null,
  };
}

/** The instance the detail/progress panel is currently showing. */
function activeInstance() {
  if (activeInstanceId) {
    const hit = tasks.find((t) => t.id === activeInstanceId);
    if (hit) return hit;
  }
  // Fall back to the most recently active instance.
  return [...tasks].sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))[0] || null;
}

/** Select which instance's progress the detail panel shows. */
export function setActiveInstance(id) {
  activeInstanceId = id;
  renderInstances(tasks);
  renderActiveDetail();
  renderNarrative(narrativeEntries);
}

/** Render the left-rail session list — one card per instance. */
function renderInstances(list) {
  const container = document.getElementById("instanceList");
  const countEl = document.getElementById("instanceCount");
  if (!container) return;
  if (countEl) countEl.textContent = String(list.length);

  if (!list.length) {
    container.replaceChildren(Object.assign(document.createElement("div"), {
      className: "instance-empty",
      textContent: "no active sessions",
    }));
    return;
  }

  const active = activeInstance();
  const fragment = document.createDocumentFragment();
  for (const inst of list) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "instance-card";
    card.dataset.id = inst.id;
    card.dataset.provider = inst.provider;
    card.dataset.status = inst.status;
    card.setAttribute("role", "listitem");
    card.setAttribute("aria-pressed", String(inst.id === active?.id));
    if (inst.id === active?.id) card.classList.add("is-active");

    const dot = document.createElement("span");
    dot.className = "instance-dot";
    dot.dataset.status = inst.status;

    const main = document.createElement("div");
    main.className = "instance-main";
    const label = document.createElement("div");
    label.className = "instance-label";
    label.textContent = inst.label || inst.cwdLabel || "—";
    label.title = inst.cwdLabel || "";
    // Provider · status and the elapsed timer share the sub-line so the label
    // above keeps the card's full width.
    const sub = document.createElement("div");
    sub.className = "instance-sub";
    const status = document.createElement("span");
    status.className = "instance-status";
    status.textContent = `${PROVIDER_LABEL[inst.provider] || inst.provider} · ${STATUS_WORDS[inst.status] || inst.status}`;
    const elapsed = document.createElement("span");
    elapsed.className = "instance-elapsed";
    elapsed.dataset.startedAt = inst.startedAt ? String(inst.startedAt) : "";
    elapsed.textContent = fmtElapsed(inst.startedAt, Date.now());
    sub.append(status, elapsed);
    main.append(label, sub);

    card.append(dot, main);
    fragment.appendChild(card);
  }
  container.replaceChildren(fragment);
}

/** Render the active instance's status/label/elapsed above the progress panel. */
function renderActiveDetail() {
  const inst = activeInstance();
  const dot = document.getElementById("statusDot");
  const word = document.getElementById("statusWord");
  const label = document.getElementById("taskLabel");
  const elapsed = document.getElementById("taskElapsed");
  const status = inst ? inst.status : "idle";
  if (dot) dot.dataset.status = status;
  if (word) word.textContent = STATUS_WORDS[status] || status.toUpperCase();
  if (inst && (inst.label || inst.cwdLabel)) {
    if (label) {
      label.textContent = inst.label || inst.cwdLabel || "—";
      label.title = inst.cwdLabel || "";
    }
  } else if (label) {
    label.textContent = "waiting for a task…";
  }
  // Elapsed is refreshed by the ticker, but set it once here too.
  if (elapsed) elapsed.textContent = fmtElapsed(inst?.startedAt, Date.now());
}

/** Render ONLY the active instance's latest narrative (single entry). */
function renderNarrative(entries) {
  const stream = document.getElementById("narrativeStream");
  if (!stream) return;
  const inst = activeInstance();
  const entry = inst ? entries.find((n) => n.instanceId === inst.id) : null;

  if (!entry) {
    stream.replaceChildren(Object.assign(document.createElement("div"), {
      className: "narrative-empty",
      textContent: inst
        ? `waiting for ${PROVIDER_LABEL[inst.provider] || "this session"} progress…`
        : "waiting for visible progress…",
    }));
    return;
  }

  const article = document.createElement("article");
  article.className = "narrative-entry is-latest";

  const meta = document.createElement("div");
  meta.className = "narrative-meta";
  const provider = document.createElement("span");
  provider.textContent = PROVIDER_LABEL[entry.provider] || entry.provider.toUpperCase();
  const phase = document.createElement("span");
  phase.textContent = entry.phase === "final" ? "FINAL" : "UPDATE";
  meta.append(provider, phase);

  const text = document.createElement("div");
  text.className = "narrative-text";
  text.textContent = entry.text;
  article.append(meta, text);
  stream.replaceChildren(article);
}

function fmtElapsed(startedAt, now) {
  if (!startedAt) return "00:00";
  const secs = Math.max(0, Math.floor((now - startedAt) / 1000));
  const h = Math.floor(secs / 3600);
  const mm = String(Math.floor((secs % 3600) / 60)).padStart(2, "0");
  const ss = String(secs % 60).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Windows we expect per provider, so a missing one is shown, not silently gone. */
const EXPECTED_WINDOWS = {
  codex: [
    { key: "codex_5h", label: "Codex 5h" },
    { key: "codex_7d", label: "Codex 7d" },
    { key: "codex_resets", label: "Resets" },
  ],
  claude: [
    { key: "claude_5h", label: "Claude 5h" },
    { key: "claude_7d", label: "Claude 7d" },
  ],
};

/** Why a provider has no cards at all, phrased for the person reading the wall. */
const SOURCE_EMPTY_TEXT = {
  unavailable: "not connected",
  live: "no windows reported",
  config: "awaiting data",
  observed: "awaiting data",
};

function renderMetrics(metrics, sources) {
  const grid = document.getElementById("quotaGrid");
  if (!grid) return;
  if (sources) lastSources = sources;
  lastMetrics = metrics || [];

  // Group metrics by provider, each under an account-name header.
  const byProvider = { codex: [], claude: [] };
  for (const m of metrics) {
    const p = byProvider[m.provider] || (byProvider[m.provider] = []);
    p.push(m);
  }

  // Each provider always gets a section: a header (account name) + its cards,
  // or a "not connected" placeholder when it has none.
  const seen = new Set();
  const fragment = document.createDocumentFragment();
  for (const provider of ["codex", "claude"]) {
    const items = byProvider[provider] || [];
    const accountName = items[0]?.accountName || (provider === "claude" ? "Claude Code" : "Codex");

    const section = document.createElement("section");
    section.className = "quota-section";
    section.dataset.provider = provider;

    const head = document.createElement("div");
    head.className = "quota-section-head";
    const tag = document.createElement("span");
    tag.className = `quota-section-tag provider-${provider}`;
    tag.textContent = provider === "claude" ? "CLAUDE" : "CODEX";
    const name = document.createElement("span");
    name.className = "quota-section-name";
    name.textContent = accountName;
    head.append(tag, name);
    section.appendChild(head);

    const cards = document.createElement("div");
    cards.className = "quota-section-cards";
    if (items.length) {
      // Render every window we expect, in a stable order. A window the API did
      // not report (Codex drops the 5h one for some plans) gets an explicit
      // "not reported" card — silently omitting it just looked like a bug.
      const byKey = new Map(items.map((m) => [m.key, m]));
      for (const expected of EXPECTED_WINDOWS[provider] || []) {
        const m = byKey.get(expected.key);
        seen.add(expected.key);
        let card = cardCache.get(expected.key);
        if (!card) {
          card = buildCard({ key: expected.key, label: expected.label });
          cardCache.set(expected.key, card);
        }
        if (m) updateCard(card, m);
        else updateCardAsMissing(card, expected.label);
        cards.appendChild(card.el);
      }
      // Anything the server sent that we didn't expect still gets shown.
      for (const m of items) {
        if (seen.has(m.key)) continue;
        seen.add(m.key);
        let card = cardCache.get(m.key);
        if (!card) {
          card = buildCard(m);
          cardCache.set(m.key, card);
        }
        updateCard(card, m);
        cards.appendChild(card.el);
      }
    } else {
      const empty = document.createElement("div");
      empty.className = "quota-section-empty";
      empty.textContent = SOURCE_EMPTY_TEXT[lastSources?.[provider]] || "not connected";
      cards.appendChild(empty);
    }
    section.appendChild(cards);
    // Tell CSS how many cards this provider has, so the column divides its
    // height per-card instead of per-provider (Codex has 3, Claude has 2).
    section.style.setProperty("--rows", String(cards.childElementCount || 1));
    fragment.appendChild(section);
  }

  grid.replaceChildren(fragment);

  // Drop cached cards that are no longer present.
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

/**
 * Show a window the provider did not report. Deliberately NOT a zero or a dash
 * next to a full bar — an unreported window must not read as a real value.
 */
function updateCardAsMissing(card, label) {
  card.el.dataset.state = "missing";
  card.label.textContent = label;
  card.value.textContent = "n/a";
  card.value.className = "quota-value is-missing";
  card.reset.textContent = "not reported";
  card.reset.style.display = "";
  card.fill.style.width = "0%";
  card.fill.className = "quota-bar-fill";
}

function updateCard(card, m) {
  delete card.el.dataset.state;
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

/** Refresh elapsed timers for all instance cards + the active detail (1s ticker). */
export function renderElapsed(now = Date.now()) {
  // Active detail elapsed.
  const inst = activeInstance();
  const el = document.getElementById("taskElapsed");
  if (el) el.textContent = fmtElapsed(inst?.startedAt, now);
  // Per-card elapsed in the instance list.
  const cards = document.querySelectorAll(".instance-elapsed");
  cards.forEach((cardEl) => {
    const startedAt = Number(cardEl.dataset.startedAt || 0);
    cardEl.textContent = fmtElapsed(startedAt, now);
  });
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
