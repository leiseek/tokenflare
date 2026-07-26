/**
 * Proxied fetch helper.
 *
 * Node's native fetch (undici) ignores the system proxy and the HTTP_PROXY
 * env var — it always connects directly. This is a real problem in networks
 * where OpenAI's host (chatgpt.com) is only reachable via a local proxy
 * (common in China, corporate networks, etc.).
 *
 * This module builds a fetch implementation that routes through an
 * `http:`/`https:` or `socks5:` proxy URL. For HTTP proxies we use
 * `https-proxy-agent`; for SOCKS we use `socks-proxy-agent` — both with the
 * Node https module (a tiny manual fetch wrapper), since undici doesn't
 * accept these agents.
 *
 * If no proxy URL is given (or it's not a recognized scheme), returns the
 * global `fetch` unchanged (direct connection).
 */
import http from "node:http";
import https from "node:https";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";

export type FetchLike = typeof fetch;

/**
 * Build a fetch implementation that routes through the given proxy URL.
 * Returns the global fetch if proxyUrl is empty or unsupported.
 */
export async function createProxiedFetch(proxyUrl: string | null | undefined): Promise<FetchLike> {
  if (!proxyUrl) return fetch;

  const parsedProxy = new URL(proxyUrl);
  const proto = parsedProxy.protocol.toLowerCase();
  const agent: http.Agent =
    proto === "socks:" || proto === "socks4:" || proto === "socks5:" || proto === "socks5h:"
      ? new SocksProxyAgent(parsedProxy)
      : proto === "http:" || proto === "https:"
        ? new HttpsProxyAgent(parsedProxy)
        : (() => {
            throw new Error(`Unsupported proxy protocol: ${parsedProxy.protocol}`);
          })();

  // A minimal fetch wrapper over http(s).request that uses the agent.
  return async function proxiedFetch(
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    if (init?.body && typeof init.body !== "string" && !Buffer.isBuffer(init.body)) {
      throw new TypeError("Proxied fetch currently supports only string or Buffer request bodies");
    }
    const body = init?.body as string | Buffer | undefined;

    return new Promise<Response>((resolve, reject) => {
      const u = new URL(url);
      const lib = u.protocol === "https:" ? https : http;
      const req = lib.request(
        {
          hostname: u.hostname,
          port: u.port || (u.protocol === "https:" ? 443 : 80),
          path: u.pathname + u.search,
          method,
          agent,
          headers: Object.fromEntries(headers.entries()),
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const buf = Buffer.concat(chunks);
            const respHeaders = new Headers();
            for (const [k, v] of Object.entries(res.headers)) {
              if (Array.isArray(v)) v.forEach((x) => respHeaders.append(k, x));
              else if (v != null) respHeaders.set(k, v);
            }
            resolve(
              new Response(buf, {
                status: res.statusCode ?? 200,
                statusText: res.statusMessage ?? "",
                headers: respHeaders,
              }),
            );
          });
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      if (init?.signal) {
        const onAbort = () => req.destroy(init.signal?.reason);
        if (init.signal.aborted) onAbort();
        else init.signal.addEventListener("abort", onAbort, { once: true });
        req.once("close", () => init.signal?.removeEventListener("abort", onAbort));
      }
      if (body) req.write(body);
      req.end();
    });
  };
}
