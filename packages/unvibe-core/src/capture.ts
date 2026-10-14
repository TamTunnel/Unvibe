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
import { chromium, type Browser, type Page, type Response } from 'playwright';

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
}

const ASSET_EXTS = new Set(['.js', '.mjs', '.css', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.woff', '.woff2', '.ttf', '.mp4', '.webm', '.ico', '.json']);

function routeKey(u: URL): string {
  return u.pathname + (u.search ? `?${u.searchParams.toString()}` : '');
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
      ...(cookies.length ? { storageState: undefined } : {}),
    });
    if (cookies.length) {
      await context.addCookies(cookies.map((c) => ({ ...c, sameSite: 'Lax' as const, secure: target.protocol === 'https:' })));
      log(`capture: added ${cookies.length} session cookie(s)`);
    }

    const seen = new Set<string>();
    const queue: { path: string; depth: number }[] = [{ path: routeKey(target) || '/', depth: 0 }];
    const routes: CapturedRoute[] = [];
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
      page.on('response', (res) => {
        void downloadAsset(res);
      });
      try {
        await page.goto(pageUrl, { waitUntil: 'networkidle', timeout: timeoutMs });
      } catch (e) {
        log(`capture: WARN could not load ${path}: ${(e as Error).message.split('\n')[0]}`);
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
        'nav,h1,h2,h3,form,input,textarea,select,button,ul,ol,table,img,video,footer,dialog,section,article',
        (els) => {
          const groups = new Map<string, { count: number; text: string }>();
          for (const el of els) {
            const tag = el.tagName.toLowerCase();
            const g = groups.get(tag) ?? { count: 0, text: '' };
            g.count++;
            if (g.text.length < 200) {
              const t = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 120);
              if (t && !g.text.includes(t)) g.text = (g.text + ' | ' + t).slice(0, 200);
            }
            groups.set(tag, g);
          }
          return [...groups.entries()].map(([tag, g]) => ({ tag, count: g.count, text: g.text }));
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
    };
    await writeFile(join(absOut, 'routes.json'), JSON.stringify(routes, null, 2));
    log(`capture: done — ${routes.length} routes, ${requestCount} asset responses`);
    return result;
  } finally {
    await browser.close();
  }
}
