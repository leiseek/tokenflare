/**
 * WebSocket client: snapshot/delta handling + auto-reconnect.
 *
 * Connects to the server, sends hello, applies snapshots fully and deltas
 * incrementally, and resyncs via a full snapshot when the revision gap is too
 * large or after a reconnect. Exponential backoff on disconnect. Never throws
 * into the render loop.
 */

const MAX_DELTA_GAP = 50;

export class VibeClient {
  /** @param {{(snapshot: any) => void}} onSnapshot */
  /** @param {{(delta: any) => void}} onDelta */
  /** @param {{(state: 'connecting'|'open'|'closed') => void}} onConnState */
  constructor({ onSnapshot, onDelta, onConnState }) {
    this.onSnapshot = onSnapshot || (() => {});
    this.onDelta = onDelta || (() => {});
    this.onConnState = onConnState || (() => {});

    this.ws = null;
    this.url = null;
    this.revision = 0;
    this.hasSnapshot = false;

    this.pingTimer = null;
    this.watchdog = null;
    this.lastMsgAt = 0;
    this.backoffMs = 1000;
    this.manualClose = false;
  }

  /** Connect to a ws URL (e.g. "ws://192.168.1.10:7331/ws"). */
  connect(url) {
    this.url = url;
    this.manualClose = false;
    this._open();
  }

  /** Force a reconnect (used by the Reconnect button). */
  reconnect() {
    this.manualClose = true;
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
    }
    this.manualClose = false;
    setTimeout(() => this._open(), 100);
  }

  /** Tear down completely. */
  close() {
    this.manualClose = true;
    this._clearTimers();
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
    }
  }

  _open() {
    this.onConnState("connecting");
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch (err) {
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.backoffMs = 1000;
      this.onConnState("open");
      this.lastMsgAt = Date.now();
      this._send({ type: "hello", client: "pwa", since: this.hasSnapshot ? this.revision : undefined });
      this._startTimers();
    };

    ws.onmessage = (ev) => {
      this.lastMsgAt = Date.now();
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === "snapshot") {
        this.revision = msg.data.revision ?? this.revision;
        this.hasSnapshot = true;
        this.onSnapshot(msg.data);
      } else if (msg.type === "delta") {
        const rev = msg.data.revision ?? 0;
        if (this.hasSnapshot && rev > this.revision && rev - this.revision <= MAX_DELTA_GAP) {
          this.revision = rev;
          this.onDelta(msg.data);
        } else {
          // Gap too big or first message: ask for a full snapshot by re-hello.
          this._send({ type: "hello", client: "pwa" });
        }
      }
      // pong: ignored (watchdog handles liveness)
    };

    ws.onclose = () => {
      this.onConnState("closed");
      this._clearTimers();
      if (!this.manualClose) this._scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose will follow; nothing to do here.
    };
  }

  _scheduleReconnect() {
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 10000);
    setTimeout(() => {
      if (!this.manualClose) this._open();
    }, delay);
  }

  _send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify(msg)); } catch { /* ignore */ }
    }
  }

  _startTimers() {
    this._clearTimers();
    // Keepalive ping every 25s.
    this.pingTimer = setInterval(() => this._send({ type: "ping" }), 25000);
    // Watchdog: if no message for 60s, force reconnect.
    this.watchdog = setInterval(() => {
      if (Date.now() - this.lastMsgAt > 60000) {
        try { this.ws && this.ws.close(); } catch { /* ignore */ }
      }
    }, 10000);
  }

  _clearTimers() {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    if (this.watchdog) { clearInterval(this.watchdog); this.watchdog = null; }
  }
}
