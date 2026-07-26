#!/usr/bin/env node
/**
 * Cross-platform "free the port" helper.
 *
 * Kills whatever process is currently listening on the Tokenflare port so the
 * server can be (re)started without a manual "close the old instance first"
 * step. Safe to run when nothing is listening — it just prints nothing and exits 0.
 *
 *   node scripts/restart.mjs            # uses TOKENFLARE_PORT or 7331
 *   node scripts/restart.mjs 7332       # explicit port
 *
 * Detection:
 *   - win32:  netstat -ano | findstr :PORT  -> taskkill /PID <pid> /F /T
 *   - POSIX:  lsof -ti :PORT (fallback fuser -k PORT/tcp)
 *
 * Never throws: a failure to kill is logged, not fatal. Exits 0 either way so
 * it can run unconditionally as an npm "prestart" / "prerestart" hook.
 */
import { execSync } from "node:child_process";
import process from "node:process";

const port = Number(process.argv[2] || process.env.TOKENFLARE_PORT || 7331);

/** Parse integers out of command output, de-duplicated. */
function pidsFrom(text) {
  const out = new Set();
  for (const m of String(text).matchAll(/\b\d{2,}\b/g)) {
    out.add(Number(m[0]));
  }
  return [...out];
}

function killPids(pids) {
  if (process.platform === "win32") {
    for (const pid of pids) {
      try {
        execSync(`taskkill /PID ${pid} /F /T`, { stdio: "ignore" });
        console.log(`[restart] killed pid ${pid} on port ${port}`);
      } catch {
        /* already gone, or no permission — ignore */
      }
    }
  } else {
    if (pids.length) {
      try {
        execSync(`kill -9 ${pids.join(" ")}`, { stdio: "ignore" });
        console.log(`[restart] killed pids ${pids.join(", ")} on port ${port}`);
      } catch {
        /* ignore */
      }
    }
  }
}

try {
  let pids = [];
  if (process.platform === "win32") {
    // netstat lines for LISTENING on :PORT look like:
    //   TCP    0.0.0.0:7331     0.0.0.0:0    LISTENING    41120
    let out = "";
    try {
      out = execSync(`netstat -ano | findstr :${port}`, { stdio: ["ignore", "pipe", "ignore"] }).toString();
    } catch {
      out = "";
    }
    pids = out
      .split(/\r?\n/)
      .filter((line) => /LISTENING/i.test(line) && new RegExp(`:${port}\\b`).test(line))
      .flatMap((line) => pidsFrom(line.split(/\s+/).pop()));
    // Fallback: if findstr matched nothing usable, try the raw PID scrape.
    if (!pids.length && out.trim()) pids = pidsFrom(out);
  } else {
    // Prefer lsof; fall back to fuser.
    try {
      const out = execSync(`lsof -ti :${port}`, { stdio: ["ignore", "pipe", "ignore"] }).toString();
      pids = pidsFrom(out);
    } catch {
      try {
        execSync(`fuser -k ${port}/tcp`, { stdio: "ignore" });
        console.log(`[restart] freed port ${port} via fuser`);
      } catch {
        /* nothing listening */
      }
    }
  }
  killPids([...new Set(pids)]);
  if (!pids.length && process.platform !== "win32") {
    // lsof/fuser path already handled; nothing to report.
  }
} catch {
  // Best-effort; never fail the start sequence.
}
process.exit(0);
