/**
 * Deterministic capture stage (Playwright).
 *
 * Crawls the live URL: route discovery via the link graph, asset download,
 * HAR recording of key flows, one screenshot per route. Optional
 * user-supplied session cookie unlocks authed routes.
 *
 * REA is deliberately NOT used here — REA is the eyes for static bundle/HAR
 * *analysis*, not for interactive crawling.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join, extname, basename } from 'node:path';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { chromium, type Browser, type Page, type Response } from 'playwright';

/**
 * Thrown when the crawler refuses to follow a navigation because it would
 * leave the target origin or reach a private/metadata IP. The offending
 * request is aborted before any bytes leave the machine.
 */
export class EgressBlockedError extends Error {
  readonly code = 'EGRESS_BLOCKED';
  constructor(message: string) {
    super(message);
    this.name = 'EgressBlockedError';
  }
}

/**
 * IP ranges that must never be reached through a redirect hop: loopback,
 * RFC-1918 private, link-local (cloud metadata endpoints live here),
 * carrier-grade NAT, and IPv6 equivalents.
 */
function isBlockedIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 127 || // 127.0.0.0/8 loopback
      a === 10 || // 10.0.0.0/8
      (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
      (a === 192 && b === 168) || // 192.168.0.0/16
      (a === 169 && b === 254) || // 169.254.0.0/16 (incl. 169.254.169.254 metadata)
      (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10 (incl. 100.100.100.100)
      a === 0 // 0.0.0.0/8
    );
  }
  if (isIP(ip) === 6) {
    const n = ip.toLowerCase();
    // Strip a possible IPv4-mapped tail and check the v4 part too.
    const mapped = n.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped && isBlockedIp(mapped[1])) return true;
    return (
      n === '::1' || // loopback
      n.startsWith('fe80:') || // fe80::/10 link-local
      n.startsWith('fc') || n.startsWith('fd') // fc00::/7 unique-local
    );
  }
  return false;
}

const dnsCache = new Map<string, string[]>();

/**
 * Validate a single egress hop. Throws EgressBlockedError when the hop:
 *  - is not http(s),
 *  - leaves the target origin (cross-origin redirect — the SSRF vector), or
 *  - resolves (via literal or DNS) to a blocked private/metadata IP while
 *    pointing at a host OTHER than the explicitly targeted one.
 *
 * The explicitly targeted initial host is always allowed — the product gate
 * (gate.ts) already scope-checked it, and tests target localhost. Every
 * *redirect hop* to a different host is untrusted until proven public.
 */
export async function assertEgressAllowed(
  requestUrl: string,
  allowedOrigin: string,
  initialHost: string,
): Promise<void> {
  let u: URL;
  try {
    u = new URL(requestUrl);
  } catch {
    throw new EgressBlockedError(`blocked: not a valid URL: ${requestUrl}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    // data:/blob: subresources never leave the document — safe to allow.
    if (u.protocol === 'data:' || u.protocol === 'blob:') return;
    throw new EgressBlockedError(`blocked: non-HTTP(S) egress to ${u.protocol}//${u.host}`);
  }
  if (u.origin !== allowedOrigin) {
    throw new EgressBlockedError(
      `blocked: redirect escapes target origin ${allowedOrigin} → ${u.origin}`,
    );
  }
  const host = u.hostname.toLowerCase();
  if (host === initialHost.toLowerCase()) return; // the explicit target; gate-scoped
  if (isIP(host) !== 0) {
    if (isBlockedIp(host)) {
      throw new EgressBlockedError(`blocked: redirect hop resolves to private/metadata IP ${host}`);
    }
    return;
  }
  let addrs = dnsCache.get(host);
  if (!addrs) {
    try {
      addrs = (await dnsLookup(host, { all: true })).map((a) => a.address);
    } catch {
      addrs = [];
    }
    dnsCache.set(host, addrs);
  }
  const bad = addrs.filter(isBlockedIp);
  if (bad.length > 0) {
    throw new EgressBlockedError(
      `blocked: redirect hop ${host} resolves to private/metadata IP(s): ${bad.join(', ')}`,
    );
  }
}

/**
 * Validate a WebSocket handshake URL. Narrower than assertEgressAllowed:
 * cross-origin PUBLIC websockets are legitimate app behavior (Supabase
 * realtime, etc.) and must keep working — the SSRF danger is specifically
 * private/metadata IPs. Throws EgressBlockedError for ws(s) URLs that
 * resolve to a blocked IP. Non-ws(s) schemes are refused outright.
 */
export async function assertWebsocketAllowed(
  requestUrl: string,
  initialHost: string,
): Promise<void> {
  let u: URL;
  try {
    u = new URL(requestUrl);
  } catch {
    throw new EgressBlockedError(`blocked: not a valid websocket URL: ${requestUrl}`);
  }
  if (u.protocol !== 'ws:' && u.protocol !== 'wss:') {
    throw new EgressBlockedError(`blocked: non-websocket scheme ${u.protocol} in websocket handler`);
  }
  const host = u.hostname.toLowerCase();
  if (host === initialHost.toLowerCase()) return; // same host as the target
  if (isIP(host) !== 0) {
    if (isBlockedIp(host)) {
      throw new EgressBlockedError(`blocked: websocket to private/metadata IP ${host}`);
    }
    return;
  }
  let addrs = dnsCache.get(host);
  if (!addrs) {
    try {
      addrs = (await dnsLookup(host, { all: true })).map((a) => a.address);
    } catch {
      addrs = [];
    }
    dnsCache.set(host, addrs);
  }
  const bad = addrs.filter(isBlockedIp);
  if (bad.length > 0) {
    throw new EgressBlockedError(
      `blocked: websocket host ${host} resolves to private/metadata IP(s): ${bad.join(', ')}`,
    );
  }
}

export interface CaptureOptions {
  url: string;
  outDir: string;
  /** e.g. "sb-access-token=eyJ...; Path=/; Domain=.lovable.app" or a JSON cookie file path */
  cookie?: string;
  maxPages?: number;
  maxDepth?: number;
  viewport?: { width: number; height: number };
  timeoutMs?: number;
  onProgress?: (msg: string) => void;
}

export interface CapturedRoute {
  path: string;
  title: string;
  screenshot: string; // relative path
  outgoingLinks: string[];
  htmlBytes: number;
}

export interface CaptureResult {
  outDir: string;
  origin: string;
  routes: CapturedRoute[];
  harPath: string; // relative
  assetsDir: string; // relative
  screenshotsDir: string; // relative
  scriptsDir: string; // relative — downloaded JS for the REA adapter
  requestCount: number;
  /** Request URLs observed per route path (for endpoint→route attribution). */
  routeRequests: Record<string, string[]>;
}

const ASSET_EXTS = new Set(['.js', '.mjs', '.css', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.woff', '.woff2', '.ttf', '.mp4', '.webm', '.ico', '.json']);

/** Query params that identify the visitor, not the page — stripped so tracking variants don't multiply routes. */
const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'gclid', 'fbclid', 'msclkid', 'mc_cid', 'mc_eid', '_ga', 'yclid', 'igshid',
]);

export function routeKey(u: URL): string {
  const params = new URLSearchParams(u.search);
  for (const p of TRACKING_PARAMS) params.delete(p);
  const q = params.toString();
  return u.pathname + (q ? `?${q}` : '');
}

async function parseCookieOption(cookie: string | undefined, origin: string): Promise<{ name: string; value: string; domain: string; path: string }[]> {
  if (!cookie) return [];
  const { readFile } = await import('node:fs/promises');
  let pairs: { name: string; value: string }[] = [];
  if (cookie.trim().startsWith('[') || cookie.trim().startsWith('{')) {
    // raw JSON array of {name,value} — or a path to such a file
    let text = cookie;
    if (cookie.endsWith('.json')) text = await readFile(cookie, 'utf8');
    const parsed: unknown = JSON.parse(text);
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    pairs = (arr as { name?: string; value?: string }[]).map((c) => ({ name: String(c.name ?? ''), value: String(c.value ?? '') }));
  } else if (cookie.endsWith('.json')) {
    const text = await readFile(cookie, 'utf8');
    const parsed = JSON.parse(text) as { name?: string; value?: string }[];
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    pairs = arr.map((c) => ({ name: String(c.name ?? ''), value: String(c.value ?? '') }));
  } else {
    // "name=value; name2=value2" header style
    pairs = cookie.split(';').map((p) => p.trim()).filter(Boolean).map((p) => {
      const i = p.indexOf('=');
      return { name: p.slice(0, i).trim(), value: p.slice(i + 1).trim() };
    }).filter((p) => p.name);
  }
  const host = new URL(origin).hostname;
  return pairs.map((p) => ({ ...p, domain: host.startsWith('.') ? host : `.${host}`, path: '/' }));
}

export async function captureSite(opts: CaptureOptions): Promise<CaptureResult> {
  const {
    url, outDir,
    maxPages = 25, maxDepth = 3,
    viewport = { width: 1280, height: 800 },
    timeoutMs = 30_000,
    onProgress,
  } = opts;
  const log = onProgress ?? (() => {});
  const target = new URL(url);
  // B2: captureSite refuses non-HTTP(S) schemes outright. Playwright would
  // happily load file:///etc/passwd into screenshots and DOM sidecars.
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new EgressBlockedError(
      `capture refused: non-HTTP(S) URL scheme "${target.protocol}". ` +
        'Unvibe captures live web apps only.',
    );
  }
  const origin = target.origin;

  const absOut = outDir;
  const assetsDir = join(absOut, 'assets');
  const screenshotsDir = join(absOut, 'screenshots');
  const scriptsDir = join(absOut, 'scripts');
  const harPath = join(absOut, 'capture.har');
  for (const d of [absOut, assetsDir, screenshotsDir, scriptsDir]) await mkdir(d, { recursive: true });

  const browser: Browser = await chromium.launch({ headless: true });
  try {
    const cookies = await parseCookieOption(opts.cookie, origin);
    const context = await browser.newContext({
      viewport,
      recordHar: { path: harPath },
    });
    // SSRF guard: validate EVERY request hop (initial + redirects + subresources).
    // checkTargetScope (gate.ts) only saw the initial URL. Playwright's
    // context.route() does NOT reliably see navigation redirects that the
    // browser follows internally (verified empirically: a 302 to 127.0.0.1
    // bypassed routing and hit the internal server). The CDP Fetch domain
    // intercepts at the network layer, so every hop — including redirects —
    // is validated before any bytes leave the machine.
    //
    // Per-page helper: installs the Fetch interceptor, returns a getter for
    // the first blocked navigation URL (null when none was blocked).
    const installEgressGuard = async (page: Page): Promise<() => string | null> => {
      let blockedNavigationUrl: string | null = null;
      const cdp = await context.newCDPSession(page);
      await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
      cdp.on('Fetch.requestPaused', (event: { requestId: string; request: { url: string }; resourceType?: string }) => {
        const url = event.request.url;
        void (async () => {
          try {
            await assertEgressAllowed(url, origin, target.hostname);
            await cdp.send('Fetch.continueRequest', { requestId: event.requestId });
          } catch (e) {
            if (event.resourceType === 'Document' && blockedNavigationUrl === null) {
              blockedNavigationUrl = url;
            }
            log(`capture: BLOCKED egress to ${url} (${(e as Error).message})`);
            await cdp.send('Fetch.failRequest', {
              requestId: event.requestId,
              errorReason: 'BlockedByClient',
            }).catch(() => {});
          }
        })();
      });
      return () => blockedNavigationUrl;
    };
    if (cookies.length) {
      await context.addCookies(cookies.map((c) => ({ ...c, sameSite: 'Lax' as const, secure: target.protocol === 'https:' })));
      log(`capture: added ${cookies.length} session cookie(s)`);
    }

    const seen = new Set<string>();
    const queue: { path: string; depth: number }[] = [{ path: routeKey(target) || '/', depth: 0 }];
    const routes: CapturedRoute[] = [];
    const routeRequestMap = new Map<string, string[]>();
    let requestCount = 0;
    let assetIndex = 0;

    const downloadAsset = async (res: Response): Promise<void> => {
      let u: URL;
      try {
        u = new URL(res.url());
      } catch {
        return;
      }
      if (u.origin !== origin) return;
      const ext = extname(u.pathname).toLowerCase();
      if (!ASSET_EXTS.has(ext) && !/\.js($|\?)/.test(u.pathname)) return;
      requestCount++;
      const isScript = ext === '.js' || ext === '.mjs' || u.pathname.endsWith('.js');
      const destDir = isScript ? scriptsDir : assetsDir;
      const name = `${String(assetIndex++).padStart(3, '0')}-${basename(u.pathname).slice(0, 60) || 'asset'}`;
      try {
        const buf = await res.body();
        await writeFile(join(destDir, name), buf);
      } catch {
        /* asset vanished mid-download; not fatal */
      }
    };

    while (queue.length > 0 && routes.length < maxPages) {
      const { path, depth } = queue.shift()!;
      if (seen.has(path)) continue;
      seen.add(path);
      const pageUrl = origin + path;
      log(`capture: visiting ${path} (depth ${depth})`);
      const page: Page = await context.newPage();
      const getBlockedNavigationUrl = await installEgressGuard(page).catch((e) => {
        log(`capture: WARN could not install egress guard: ${(e as Error).message.split('\n')[0]}`);
        return () => null as string | null;
      });
      // WebSocket SSRF guard (two layers — the CDP Fetch domain does not
      // intercept WebSocket handshakes, verified empirically):
      //
      // Layer 1 (init script): wrap window.WebSocket to synchronously refuse
      // handshakes to private/metadata IP literals (127/10/172.16/192.168/
      // 169.254/100.64/0.0.0.0, ::1/fe80/fc00::/7). No race — the handshake
      // never starts. All created sockets are registered for layer 2.
      //
      // Layer 2 (Node): page.on('websocket') runs assertWebsocketAllowed
      // (adds DNS resolution for hostnames); violations are closed from
      // inside the page via the registry (Playwright's API has no close()).
      // Same-host and public cross-origin sockets (Supabase realtime, etc.)
      // are unaffected by both layers.
      await page.addInitScript(() => {
        const OrigWebSocket = window.WebSocket;
        const registry: { ws: WebSocket; url: string }[] = [];
        const w = window as unknown as {
          __unvibeWsRegistry?: { ws: WebSocket; url: string }[];
          WebSocket: typeof WebSocket;
        };
        w.__unvibeWsRegistry = registry;
        function isBlockedIpLiteral(host: string): boolean {
          const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
          if (v4) {
            const a = Number(v4[1]);
            const b = Number(v4[2]);
            return (
              a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) ||
              (a === 192 && b === 168) || (a === 169 && b === 254) ||
              (a === 100 && b >= 64 && b <= 127) || a === 0
            );
          }
          const n = host.toLowerCase();
          return n === '::1' || n.startsWith('fe80:') || n.startsWith('fc') || n.startsWith('fd');
        }
        function PatchedWebSocket(this: unknown, url: string | URL, protocols?: string | string[]) {
          let host = '';
          try {
            host = new URL(String(url), window.location.href).hostname.toLowerCase();
          } catch {
            /* let the original constructor throw */
          }
          // Same host as the page itself is always allowed (covers the
          // UNVIBE_ALLOW_LOCALHOST dev case where the target is 127.0.0.1).
          const pageHost = window.location.hostname.toLowerCase();
          if (host && host !== pageHost && isBlockedIpLiteral(host)) {
            throw new DOMException(
              `Unvibe egress guard: websocket to private/metadata IP ${host} blocked`,
              'SecurityError',
            );
          }
          const ws =
            protocols === undefined ? new OrigWebSocket(url) : new OrigWebSocket(url, protocols);
          registry.push({ ws, url: String(url) });
          ws.addEventListener('close', () => {
            const i = registry.findIndex((e) => e.ws === ws);
            if (i >= 0) registry.splice(i, 1);
          });
          return ws;
        }
        PatchedWebSocket.prototype = OrigWebSocket.prototype;
        w.WebSocket = PatchedWebSocket as unknown as typeof WebSocket;
      }).catch((e) => {
        log(`capture: WARN could not install websocket guard: ${(e as Error).message.split('\n')[0]}`);
      });
      page.on('websocket', (ws) => {
        const wsUrl = ws.url();
        void (async () => {
          try {
            await assertWebsocketAllowed(wsUrl, target.hostname);
          } catch (e) {
            log(`capture: BLOCKED websocket to ${wsUrl} (${(e as Error).message})`);
            await page
              .evaluate((url: string) => {
                const w = window as unknown as {
                  __unvibeWsRegistry?: { ws: { close(): void }; url: string }[];
                };
                w.__unvibeWsRegistry?.find((r) => r.url === url)?.ws.close();
              }, wsUrl)
              .catch(() => {});
          }
        })();
      });
      // M3: attribute requests to the route being visited (endpoint→route).
      const pageRequests: string[] = [];
      page.on('request', (req) => {
        pageRequests.push(req.url());
      });
      const pendingDownloads: Promise<void>[] = [];
      page.on('response', (res) => {
        pendingDownloads.push(downloadAsset(res));
      });
      try {
        // Belt-and-braces: validate the initial URL too (captureSite is public API).
        await assertEgressAllowed(pageUrl, origin, target.hostname);
        // M7: domcontentloaded + a short settle delay instead of networkidle.
        // networkidle can silently drop SPA routes when a long-poll/stream
        // keeps the network busy past the timeout; we record the route even
        // when full idle times out.
        try {
          await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
        } catch (gotoErr) {
          if (getBlockedNavigationUrl()) throw gotoErr;
          log(`capture: WARN ${path} did not reach idle in ${timeoutMs}ms — recording partial route`);
        }
        await page.waitForTimeout(1500).catch(() => {});
      } catch (e) {
        await page.close().catch(() => {});
        const blocked = getBlockedNavigationUrl();
        if (blocked) {
          // The navigation was refused by the SSRF guard — fail the capture
          // loudly rather than recording an empty route set.
          throw new EgressBlockedError(
            `capture refused: navigation to ${blocked} was blocked ` +
              `(target origin: ${origin}). A redirect tried to leave the target origin ` +
              `or reach a private/metadata IP.`,
          );
        }
        log(`capture: WARN could not load ${path}: ${(e as Error).message.split('\n')[0]}`);
        continue;
      }
      // M10: after goto, the landed URL must still be inside the target
      // origin. Belt-and-braces alongside per-hop interception: if the page
      // somehow ended up cross-origin (e.g. a client-side/meta redirect the
      // interceptor didn't see), refuse the route instead of capturing it.
      let landedOrigin: string;
      try {
        landedOrigin = new URL(page.url()).origin;
      } catch {
        landedOrigin = '';
      }
      if (landedOrigin !== origin) {
        log(`capture: BLOCKED route ${path} — landed cross-origin at ${page.url()}; skipping`);
        await page.close().catch(() => {});
        continue;
      }
      const title = await page.title().catch(() => path);
      const shotName = `route-${routes.length}-${path.replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 40) || 'root'}.png`;
      await page.screenshot({ path: join(screenshotsDir, shotName), fullPage: false });
      // Link graph: same-origin links only.
      const links = await page.$$eval('a[href]', (as) =>
        as.map((a) => (a as HTMLAnchorElement).getAttribute('href') ?? '').filter(Boolean),
      ).catch(() => [] as string[]);
      const outgoing: string[] = [];
      for (const href of links) {
        try {
          const u = new URL(href, pageUrl);
          if (u.origin === origin) {
            const key = routeKey(u);
            outgoing.push(key);
            if (!seen.has(key) && depth + 1 <= maxDepth) queue.push({ path: key, depth: depth + 1 });
          }
        } catch {
          /* ignore malformed hrefs */
        }
      }
      const html = await page.content().catch(() => '');
      // Lightweight DOM inventory sidecar for analyze (tag counts + text samples).
      // Behavioral only — no script contents, no bundle text.
      const domInventory = await page.$$eval(
        'nav,h1,h2,h3,form,input,textarea,select,button,ul,ol,table,img,video,footer,dialog',
        (els) => {
          const textOf = (el: Element): string => {
            const parts: string[] = [];
            const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
            let n: Node | null;
            while ((n = walker.nextNode())) {
              const t = (n.textContent ?? '').trim().replace(/\s+/g, ' ');
              if (t) parts.push(t);
            }
            return parts.join(' | ').slice(0, 400);
          };
          const groups = new Map<string, { count: number; text: string }>();
          for (const el of els) {
            const tag = el.tagName.toLowerCase();
            // Skip elements nested inside an already-inventoried ancestor of the same tag.
            const g = groups.get(tag) ?? { count: 0, text: '' };
            g.count++;
            const t = textOf(el);
            if (t && g.text.length < 400 && !g.text.includes(t)) {
              g.text = (g.text ? g.text + ' || ' : '') + t;
            }
            groups.set(tag, g);
          }
          return [...groups.entries()].map(([tag, g]) => ({ tag, count: g.count, text: g.text.slice(0, 400) }));
        },
      ).catch(() => [] as { tag: string; count: number; text: string }[]);
      const domDir = join(absOut, 'dom');
      await mkdir(domDir, { recursive: true });
      await writeFile(
        join(domDir, `${path.replace(/[^a-zA-Z0-9]+/g, '_') || 'root'}.json`),
        JSON.stringify(domInventory),
      );
      routes.push({
        path,
        title: title || path,
        screenshot: join('screenshots', shotName),
        outgoingLinks: [...new Set(outgoing)],
        htmlBytes: html.length,
      });
      routeRequestMap.set(path, [...new Set(pageRequests)]);
      // m7: await in-flight asset downloads before closing the page, so the
      // scripts/assets inventory isn't racy against browser shutdown.
      await Promise.allSettled(pendingDownloads);
      await page.close().catch(() => {});
    }

    await context.close();
    const rel = (p: string) => p.slice(absOut.length + 1);
    const result: CaptureResult = {
      outDir: absOut,
      origin,
      routes,
      harPath: rel(harPath),
      assetsDir: rel(assetsDir),
      screenshotsDir: rel(screenshotsDir),
      scriptsDir: rel(scriptsDir),
      requestCount,
      routeRequests: Object.fromEntries(routeRequestMap),
    };
    await writeFile(join(absOut, 'routes.json'), JSON.stringify(routes, null, 2));
    log(`capture: done — ${routes.length} routes, ${requestCount} asset responses`);
    return result;
  } finally {
    await browser.close();
  }
}
