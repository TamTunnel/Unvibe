/**
 * REA adapter — REA is the eyes, not the hands.
 *
 * A thin, swappable interface for static bundle inventory and HAR analysis.
 * The default implementation shells out to the `rea-agents` npm package
 * (pinned version, MIT). When REA is unavailable or a command's surface
 * doesn't fit Unvibe's deterministic capture, the adapter degrades
 * gracefully to a local static scanner — analysis never hard-fails.
 *
 * Adaptation notes (honest, recorded):
 * - `analyze-web-bundle` / `export-web-scripts` require a live CDP session
 *   or a REA capture envelope, which Unvibe's deterministic Playwright
 *   capture does not produce. For downloaded scripts we instead use REA's
 *   `analyze-javascript-application` (local dir in, evidence out) plus a
 *   local static pass for fetch call-sites and endpoint strings.
 * - `inspect-web-network-capture` takes a retained HAR — a perfect fit —
 *   but validates strictly; on rejection we fall back to our own HAR parser.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';

const execFileAsync = promisify(execFile);

/** Pinned rea-agents version (MIT). Update deliberately, not on every run. */
export const REA_PINNED_VERSION = '6.4.0';
const REA_NPX_SPEC = `rea-agents@${REA_PINNED_VERSION}`;

/** Static inventory of downloaded bundle scripts. No source text included. */
export interface BundleInventory {
  scripts: { url: string; localPath: string; bytes: number }[];
  /** Import edges: script → imported module specifier/URL. */
  importGraph: { from: string; to: string }[];
  /** Endpoint-ish strings referenced in scripts (fetch/axios call sites, URL literals). */
  referencedEndpoints: string[];
  /** Auth/third-party provider hints, e.g. ["supabase", "stripe"]. */
  providerHints: string[];
  /** Where each finding came from: "rea" or "local". */
  provenance: 'rea' | 'local' | 'mixed';
}

/** Endpoint candidates extracted from a HAR capture. */
export interface HarEndpointCandidate {
  method: string;
  url: string;
  requestBody?: unknown;
  responseBody?: unknown;
  status: number;
  contentType?: string;
}

export interface ReaAdapter {
  readonly name: string;
  /** True when the underlying engine can run. Never throws. */
  available(): Promise<boolean>;
  /** Static inventory of a directory of downloaded scripts. */
  analyzeBundle(scriptsDir: string, origin: string): Promise<BundleInventory>;
  /** Endpoint candidates from a HAR file. */
  inspectHar(harPath: string): Promise<HarEndpointCandidate[]>;
}

/** Run a rea-agents CLI command, returning parsed JSON lines (progress filtered). */
async function runRea(args: string[], timeoutMs: number): Promise<unknown[]> {
  const { stdout } = await execFileAsync('npx', ['-y', REA_NPX_SPEC, ...args], {
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  const docs: unknown[] = [];
  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const doc = JSON.parse(t) as { rea_progress?: unknown; code?: string };
      if (doc.rea_progress) continue; // progress heartbeat, not data
      docs.push(doc);
    } catch {
      /* ignore malformed lines */
    }
  }
  return docs;
}

/** Recursively collect string values that look like endpoint references. */
function harvestEndpointStrings(value: unknown, out: Set<string>, depth = 0): void {
  if (depth > 12) return;
  if (typeof value === 'string') {
    const s = value.trim();
    if (
      s.length > 3 && s.length < 500 &&
      (/^https?:\/\//.test(s) || s.startsWith('/api/') || s.startsWith('/rest/') || /\/v1\//.test(s))
    ) {
      out.add(s);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) harvestEndpointStrings(v, out, depth + 1);
    return;
  }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) harvestEndpointStrings(v, out, depth + 1);
  }
}

const PROVIDER_MARKERS: [RegExp, string][] = [
  [/supabase/i, 'supabase'],
  [/\.supabase\.co/i, 'supabase'],
  [/clerk/i, 'clerk'],
  [/firebase|firestore\.googleapis|firebasedatabase/i, 'firebase'],
  [/auth0/i, 'auth0'],
  [/stripe/i, 'stripe'],
  [/segment\.io|analytics\.js/i, 'segment'],
  [/posthog/i, 'posthog'],
  [/sentry/i, 'sentry'],
  [/googletagmanager|google-analytics/i, 'google-analytics'],
  [/intercom/i, 'intercom'],
  [/mapbox/i, 'mapbox'],
];

/** Deterministic local static scan of downloaded scripts. No network, no REA. */
export async function localBundleScan(scriptsDir: string): Promise<BundleInventory> {
  const scripts: BundleInventory['scripts'] = [];
  const importGraph: BundleInventory['importGraph'] = [];
  const endpoints = new Set<string>();
  const hints = new Set<string>();

  async function walk(dir: string): Promise<void> {
    let entries: string[] = [];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e);
      const st = await stat(p).catch(() => null);
      if (!st) continue;
      if (st.isDirectory()) {
        await walk(p);
      } else if (['.js', '.mjs', '.cjs', '.ts'].includes(extname(p))) {
        const rel = p.slice(scriptsDir.length + 1);
        scripts.push({ url: rel, localPath: rel, bytes: st.size });
        if (st.size > 5 * 1024 * 1024) continue; // skip giant bundles for regex scan
        const text = await readFile(p, 'utf8').catch(() => '');
        // import edges
        for (const m of text.matchAll(/(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
          const target = m[1] ?? m[2];
          if (target) importGraph.push({ from: rel, to: target });
        }
        // fetch / axios / URL call sites
        for (const m of text.matchAll(/(?:fetch|axios\.(?:get|post|put|patch|delete)|new\s+URL)\s*\(\s*[`'\"]([^`'\"]+)[`'\"]/g)) {
          const u = m[1];
          if (u && (u.startsWith('/') || u.startsWith('http'))) endpoints.add(u);
        }
        // bare endpoint-ish string literals
        for (const m of text.matchAll(/['\"`](\/api\/[\w\-./{}:]+|https?:\/\/[a-zA-Z0-9.\-_:/?=&%]+)['\"`]/g)) {
          endpoints.add(m[1]);
        }
        for (const [re, name] of PROVIDER_MARKERS) {
          if (re.test(text)) hints.add(name);
        }
      }
    }
  }
  await walk(scriptsDir);
  return {
    scripts,
    importGraph,
    referencedEndpoints: [...endpoints],
    providerHints: [...hints],
    provenance: 'local',
  };
}

/** Local HAR parser — the deterministic backbone for endpoint inventory. */
export async function localHarParse(harPath: string): Promise<HarEndpointCandidate[]> {
  const raw = await readFile(harPath, 'utf8');
  const har = JSON.parse(raw) as {
    log?: { entries?: Array<{
      request?: { method?: string; url?: string; postData?: { text?: string; mimeType?: string } };
      response?: { status?: number; headers?: { name: string; value: string }[]; content?: { mimeType?: string; text?: string; encoding?: string } };
    }> };
  };
  const out: HarEndpointCandidate[] = [];
  for (const e of har.log?.entries ?? []) {
    const req = e.request;
    const res = e.response;
    if (!req?.url || !req.method) continue;
    const ct = res?.content?.mimeType ?? res?.headers?.find((h) => h.name.toLowerCase() === 'content-type')?.value;
    const parseBody = (text?: string, encoding?: string): unknown | undefined => {
      if (!text) return undefined;
      try {
        const buf = encoding === 'base64' ? Buffer.from(text, 'base64').toString('utf8') : text;
        return JSON.parse(buf);
      } catch {
        return undefined;
      }
    };
    out.push({
      method: req.method.toUpperCase(),
      url: req.url,
      requestBody: parseBody(req.postData?.text),
      responseBody: ct?.includes('json') ? parseBody(res?.content?.text, res?.content?.encoding) : undefined,
      status: res?.status ?? 0,
      contentType: ct,
    });
  }
  return out;
}

/** REA-backed adapter: tries rea-agents first, degrades to local scanning. */
export class ReaCliAdapter implements ReaAdapter {
  readonly name = `rea-cli@${REA_PINNED_VERSION}`;
  private reaOk: boolean | null = null;

  async available(): Promise<boolean> {
    if (this.reaOk !== null) return this.reaOk;
    try {
      const docs = await runRea(['doctor', '--format', 'json'], 60_000);
      this.reaOk = docs.length > 0;
    } catch {
      this.reaOk = false;
    }
    return this.reaOk;
  }

  async analyzeBundle(scriptsDir: string, _origin: string): Promise<BundleInventory> {
    const local = await localBundleScan(scriptsDir);
    if (!(await this.available())) return local;
    try {
      const docs = await runRea(['analyze-javascript-application', scriptsDir, '--format', 'json'], 180_000);
      const reaEndpoints = new Set<string>();
      const reaHints = new Set<string>();
      for (const d of docs) harvestEndpointStrings(d, reaEndpoints);
      const blob = JSON.stringify(docs).slice(0, 20_000_000);
      for (const [re, name] of PROVIDER_MARKERS) {
        if (re.test(blob)) reaHints.add(name);
      }
      const merged = new Set([...local.referencedEndpoints, ...reaEndpoints]);
      const mergedHints = new Set([...local.providerHints, ...reaHints]);
      return {
        ...local,
        referencedEndpoints: [...merged],
        providerHints: [...mergedHints],
        provenance: reaEndpoints.size > 0 || reaHints.size > local.providerHints.length ? 'mixed' : 'local',
      };
    } catch {
      return local; // graceful degradation
    }
  }

  async inspectHar(harPath: string): Promise<HarEndpointCandidate[]> {
    const local = await localHarParse(harPath);
    if (!(await this.available())) return local;
    try {
      const docs = await runRea(['inspect-web-network-capture', harPath, 'har', '--format', 'json'], 120_000);
      const envelope = JSON.stringify(docs);
      if (/invalid_request|invalid_input/.test(envelope) || docs.length === 0) return local;
      const reaEndpoints = new Set<string>();
      for (const d of docs) harvestEndpointStrings(d, reaEndpoints);
      // REA's HAR inspection is evidence-oriented, not a clean endpoint list;
      // treat its URL findings as supplementary endpoint candidates.
      const seen = new Set(local.map((c) => `${c.method} ${c.url}`));
      const extra: HarEndpointCandidate[] = [];
      for (const u of reaEndpoints) {
        const key = `GET ${u}`;
        if (!seen.has(key)) {
          seen.add(key);
          extra.push({ method: 'GET', url: u, status: 0 });
        }
      }
      return [...local, ...extra];
    } catch {
      return local; // graceful degradation
    }
  }
}

/** Local-only adapter — used when REA is explicitly disabled or for hermetic tests. */
export class LocalAdapter implements ReaAdapter {
  readonly name = 'local-fallback';
  async available(): Promise<boolean> {
    return true;
  }
  async analyzeBundle(scriptsDir: string, _origin: string): Promise<BundleInventory> {
    return localBundleScan(scriptsDir);
  }
  async inspectHar(harPath: string): Promise<HarEndpointCandidate[]> {
    return localHarParse(harPath);
  }
}

/** Factory. `mode: 'auto'` tries REA, `mode: 'off'` forces the local fallback. */
export function createAdapter(mode: 'auto' | 'off' = 'auto'): ReaAdapter {
  return mode === 'off' ? new LocalAdapter() : new ReaCliAdapter();
}
