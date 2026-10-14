/**
 * Deterministic analyze stage.
 *
 * Turns a capture into the UnvibeSpec: route map, API endpoint inventory
 * (HAR + fetch call-sites in bundles), data model inference (JSON payload
 * shapes → TS-ready entities), asset inventory, auth-provider detection,
 * third-party service inventory, and the unrecoverable-gaps list.
 *
 * Deterministic: the same capture always yields the same spec. The LLM is
 * used at most for naming/summarizing (via an optional namer callback);
 * entity and component names have deterministic fallbacks.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import {
  parseSpec,
  SPEC_VERSION,
  type UnvibeSpec, type SpecEndpoint, type SpecEntity,
  type SpecRoute, type SpecAsset, type SpecAuth, type SpecThirdParty,
  type SpecGap, type JsonShape, type SpecComponent,
} from './spec.js';
import {
  createAdapter, type ReaAdapter, type HarEndpointCandidate,
} from './rea-adapter.js';
import type { CaptureResult, CapturedRoute } from './capture.js';

export interface AnalyzeOptions {
  captureDir: string;
  capture: CaptureResult;
  sourceUrl: string;
  ownership: { attestedAt: string; method: 'flag' | 'prompt' };
  unvibeVersion: string;
  /** Optional LLM-backed namer: (kind, hint) => name. Falls back to deterministic names. */
  namer?: (kind: 'entity' | 'component', hint: string) => Promise<string>;
  reaMode?: 'auto' | 'off';
  onProgress?: (msg: string) => void;
}

/** Normalize a URL into a pattern: numeric/uuid path segments → :param. */
export function normalizeUrlPattern(url: string): string {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    path = url.split('?')[0];
  }
  return path
    .split('/')
    .map((seg) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg) || /^\d+$/.test(seg)
        ? ':param'
        : seg,
    )
    .join('/');
}

/** Infer a JSON shape from a runtime value. Examples are truncated. */
export function inferShape(value: unknown, depth = 0): JsonShape {
  if (value === null) return { type: 'null' };
  if (Array.isArray(value)) {
    const itemShapes = value.slice(0, 5).map((v) => inferShape(v, depth + 1));
    const merged = mergeShapes(itemShapes);
    return { type: 'array', items: merged, examples: value.slice(0, 1) };
  }
  switch (typeof value) {
    case 'string': {
      const v = value as string;
      const format =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? 'uuid'
        : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) ? 'date-time'
        : /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) ? 'email'
        : /^https?:\/\//.test(v) ? 'url'
        : undefined;
      return { type: 'string', ...(format ? { format } : {}), examples: [v.slice(0, 80)] };
    }
    case 'number': return { type: 'number', examples: [value] };
    case 'boolean': return { type: 'boolean', examples: [value] };
    case 'object': {
      if (depth > 6) return { type: 'object' };
      const props: Record<string, JsonShape> = {};
      const required: string[] = [];
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        props[k] = inferShape(v, depth + 1);
        if (v !== null && v !== undefined) required.push(k);
      }
      return { type: 'object', properties: props, required };
    }
    default:
      return { type: 'unknown' };
  }
}

function mergeShapes(shapes: JsonShape[]): JsonShape {
  if (shapes.length === 0) return { type: 'unknown' };
  const first = shapes[0];
  if (shapes.every((s) => s.type === first.type)) {
    if (first.type === 'object') {
      const props: Record<string, JsonShape> = {};
      const counts: Record<string, number> = {};
      for (const s of shapes) {
        for (const [k, v] of Object.entries(s.properties ?? {})) {
          props[k] = props[k] ? mergeShapes([props[k], v]) : v;
          counts[k] = (counts[k] ?? 0) + 1;
        }
      }
      return { type: 'object', properties: props, required: Object.keys(counts).filter((k) => counts[k] === shapes.length) };
    }
    return first;
  }
  return { type: 'unknown' };
}

/** Heuristic: is this URL an API call rather than a page/asset? */
function looksLikeApi(url: string, contentType?: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const p = u.pathname.toLowerCase();
  if (/\.(js|css|png|jpe?g|gif|webp|svg|woff2?|ttf|ico|map)(\?|$)/.test(p)) return false;
  if (/\/api\/|\/rest\/|\/graphql|\/v1\/|\.supabase\.co\/|\.firebaseio\.com|firestore\.googleapis/.test(url)) return true;
  if (contentType?.includes('json')) return true;
  return false;
}

const SUPABASE_TABLE_RE = /\/rest\/v1\/([a-zA-Z0-9_]+)/;

export async function analyzeCapture(opts: AnalyzeOptions): Promise<UnvibeSpec> {
  const log = opts.onProgress ?? (() => {});
  const adapter: ReaAdapter = createAdapter(opts.reaMode ?? 'auto');
  const capDir = opts.captureDir;
  const capture = opts.capture;

  // 1. HAR → endpoint candidates (REA eyes + local deterministic parse).
  log('analyze: inspecting HAR capture');
  const harPath = join(capDir, capture.harPath);
  const harCandidates: HarEndpointCandidate[] = await adapter.inspectHar(harPath).catch(() => []);

  // 2. Bundle inventory (REA eyes + local static scan).
  log('analyze: inventorying downloaded scripts');
  const scriptsDir = join(capDir, capture.scriptsDir);
  const inventory = await adapter.analyzeBundle(scriptsDir, capture.origin).catch(() => null);

  // 3. Merge HAR endpoints + bundle-referenced endpoints.
  const endpoints: SpecEndpoint[] = [];
  const seenPatterns = new Map<string, SpecEndpoint>();
  const addEndpoint = (c: HarEndpointCandidate, origin: 'har' | 'bundle', routePath?: string) => {
    if (!looksLikeApi(c.url, c.contentType) && origin === 'har') return;
    const pattern = normalizeUrlPattern(c.url);
    const key = `${c.method.toUpperCase()} ${pattern}`;
    let ep = seenPatterns.get(key);
    if (!ep) {
      ep = {
        id: `ep-${seenPatterns.size + 1}`,
        method: c.method.toUpperCase() as SpecEndpoint['method'],
        url: c.url.split('?')[0],
        urlPattern: pattern,
        origin,
        sampleCount: 0,
        routes: [],
      };
      seenPatterns.set(key, ep);
      endpoints.push(ep);
    }
    ep.sampleCount++;
    if (c.requestBody !== undefined && !ep.requestShape) {
      try { ep.requestShape = inferShape(c.requestBody); } catch { /* ignore */ }
    }
    if (c.responseBody !== undefined && !ep.responseShape) {
      try { ep.responseShape = inferShape(c.responseBody); } catch { /* ignore */ }
    }
    if (routePath && !ep.routes.includes(routePath)) ep.routes.push(routePath);
  };

  for (const c of harCandidates) {
    if (c.status !== 0 && (c.status < 200 || c.status >= 500)) continue;
    addEndpoint(c, 'har');
  }
  // Bundle-referenced endpoints: static call-sites not seen in the HAR.
  for (const ref of inventory?.referencedEndpoints ?? []) {
    const abs = ref.startsWith('http') ? ref : `${capture.origin}${ref.startsWith('/') ? '' : '/'}${ref}`;
    const key = `GET ${normalizeUrlPattern(abs)}`;
    if (!seenPatterns.has(key) && looksLikeApi(abs)) {
      addEndpoint({ method: 'GET', url: abs, status: 0 }, 'bundle');
    }
  }

  // 4. Data model inference — ONLY from observed payloads. Never invented.
  log('analyze: inferring data model from observed payloads');
  const entities: SpecEntity[] = [];
  const entityByName = new Map<string, SpecEntity>();
  for (const ep of endpoints) {
    const shapes: { shape: JsonShape; evidence: string }[] = [];
    if (ep.responseShape?.type === 'array' && ep.responseShape.items?.type === 'object') {
      shapes.push({ shape: ep.responseShape.items, evidence: `${ep.method} ${ep.urlPattern} → response[]` });
    } else if (ep.responseShape?.type === 'object' && ep.responseShape.properties?.data?.type === 'array') {
      const items = ep.responseShape.properties.data.items;
      if (items?.type === 'object') shapes.push({ shape: items, evidence: `${ep.method} ${ep.urlPattern} → response.data[]` });
    } else if (ep.responseShape?.type === 'object' && Object.keys(ep.responseShape.properties ?? {}).length > 0) {
      shapes.push({ shape: ep.responseShape, evidence: `${ep.method} ${ep.urlPattern} → response` });
    }
    for (const { shape, evidence } of shapes) {
      // Table name: prefer Supabase-style /rest/v1/<table>, else endpoint path tail.
      const m = ep.url.match(SUPABASE_TABLE_RE);
      const table = m ? m[1] : ep.urlPattern.split('/').filter(Boolean).pop()?.replace(/[^a-z0-9_]/gi, '').toLowerCase() || 'record';
      const key = `${table}:${Object.keys(shape.properties ?? {}).sort().join(',')}`;
      let entity = entityByName.get(key);
      if (!entity) {
        const fieldNames = Object.keys(shape.properties ?? {}).slice(0, 6).join(', ');
        const base = table.replace(/(^|_)([a-z])/g, (_p1: string, p2: string) => p2.toUpperCase()).replace(/_/g, '');
        const pascalBase = base.charAt(0).toUpperCase() + base.slice(1);
        // Deterministic by default; a custom namer (e.g. LLM) may polish the name.
        let name = pascalBase;
        if (opts.namer) {
          try {
            name = await opts.namer('entity', `${pascalBase} (observed fields: ${fieldNames})`);
          } catch { /* deterministic fallback */ }
        }
        entity = {
          name,
          tableName: table.toLowerCase(),
          fields: Object.entries(shape.properties ?? {}).map(([fname, fshape]) => ({
            name: fname,
            type: fshape.type === 'number' ? 'number' as const
              : fshape.type === 'boolean' ? 'boolean' as const
              : fshape.format === 'date-time' ? 'date' as const
              : fshape.format === 'uuid' ? 'uuid' as const
              : fshape.type === 'object' || fshape.type === 'array' ? 'json' as const
              : 'string' as const,
            nullable: !(shape.required ?? []).includes(fname),
          })),
          source: 'har-payload',
          evidence: [],
        };
        entityByName.set(key, entity);
        entities.push(entity);
      }
      if (!entity.evidence.includes(evidence)) entity.evidence.push(evidence);
    }
  }

  // 5. Auth provider detection (bundle markers + network hosts).
  log('analyze: detecting auth provider');
  const auth = detectAuth(inventory?.providerHints ?? [], harCandidates.map((c) => c.url));

  // 6. Third-party inventory.
  const thirdParty = detectThirdParty(inventory?.providerHints ?? [], harCandidates.map((c) => c.url));

  // 7. Asset inventory from capture dir.
  const assets = await inventoryAssets(capDir, capture);

  // 8. Routes: behavioral component inventory from captured DOM.
  log('analyze: building route map');
  const routes: SpecRoute[] = [];
  for (const r of capture.routes) {
    routes.push({
      path: r.path,
      title: r.title,
      screenshot: r.screenshot,
      outgoingLinks: r.outgoingLinks,
      components: await extractComponents(capDir, r, opts.namer),
      apiCalls: endpoints.filter((e) => e.routes.includes(r.path)).map((e) => e.id),
    });
  }

  // 9. Unrecoverable gaps — honest partial recovery.
  const gaps = buildGaps(auth, endpoints, thirdParty);

  const spec = parseSpec({
    specVersion: SPEC_VERSION,
    source: {
      platform: 'lovable',
      url: opts.sourceUrl,
      capturedAt: new Date().toISOString(),
      unvibeVersion: opts.unvibeVersion,
    },
    ownership: opts.ownership,
    routes,
    endpoints,
    entities,
    assets,
    auth,
    thirdParty,
    gaps,
    stats: {
      pagesVisited: capture.routes.length,
      requestsCaptured: harCandidates.length,
      scriptsAnalyzed: inventory?.scripts.length ?? 0,
    },
  });
  log(`analyze: spec complete — ${routes.length} routes, ${endpoints.length} endpoints, ${entities.length} entities, ${gaps.length} gaps`);
  return spec;
}

function detectAuth(providerHints: string[], urls: string[]): SpecAuth {
  const evidence: string[] = [];
  const hostHit = (re: RegExp, label: string) => {
    if (urls.some((u) => re.test(u))) evidence.push(label);
  };
  const hintHit = (name: string, label: string) => {
    if (providerHints.includes(name)) evidence.push(label);
  };
  hostHit(/\.supabase\.co\//, 'network: *.supabase.co requests'); hintHit('supabase', 'bundle: supabase marker strings');
  hostHit(/clerk\./, 'network: clerk.* requests'); hintHit('clerk', 'bundle: clerk marker strings');
  hostHit(/firestore\.googleapis|firebasedatabase|identitytoolkit/, 'network: firebase endpoints'); hintHit('firebase', 'bundle: firebase marker strings');
  hostHit(/\.auth0\.com/, 'network: auth0 requests'); hintHit('auth0', 'bundle: auth0 marker strings');

  let provider: SpecAuth['provider'] = 'none';
  if (evidence.some((e) => e.includes('supabase'))) provider = 'supabase';
  else if (evidence.some((e) => e.includes('clerk'))) provider = 'clerk';
  else if (evidence.some((e) => e.includes('firebase'))) provider = 'firebase';
  else if (evidence.some((e) => e.includes('auth0'))) provider = 'auth0';
  else if (providerHints.length > 0 || urls.length > 0) provider = 'unknown';
  return { provider, evidence };
}

const THIRD_PARTY_PATTERNS: { re: RegExp; name: string; category: SpecThirdParty['category'] }[] = [
  { re: /stripe/, name: 'stripe', category: 'payments' },
  { re: /paypal/, name: 'paypal', category: 'payments' },
  { re: /googletagmanager|google-analytics/, name: 'google-analytics', category: 'analytics' },
  { re: /segment\.io/, name: 'segment', category: 'analytics' },
  { re: /posthog/, name: 'posthog', category: 'analytics' },
  { re: /sentry/, name: 'sentry', category: 'error-tracking' },
  { re: /intercom/, name: 'intercom', category: 'other' },
  { re: /mapbox/, name: 'mapbox', category: 'maps' },
  { re: /resend|sendgrid|mailgun/, name: 'email-provider', category: 'email' },
];

function detectThirdParty(providerHints: string[], urls: string[]): SpecThirdParty[] {
  const found = new Map<string, SpecThirdParty>();
  const hay = [...providerHints, ...urls].join('\n').toLowerCase();
  for (const p of THIRD_PARTY_PATTERNS) {
    if (p.re.test(hay)) {
      const ev = urls.filter((u) => p.re.test(u.toLowerCase())).slice(0, 3);
      found.set(p.name, { name: p.name, category: p.category, evidence: ev.length ? ev : [`bundle marker: ${p.name}`] });
    }
  }
  return [...found.values()];
}

async function inventoryAssets(capDir: string, capture: CaptureResult): Promise<SpecAsset[]> {
  const out: SpecAsset[] = [];
  for (const [relDir, kind] of [[capture.assetsDir, 'other'], [capture.scriptsDir, 'script']] as const) {
    const dir = join(capDir, relDir);
    let entries: string[] = [];
    try { entries = await readdir(dir); } catch { continue; }
    for (const e of entries) {
      const st = await stat(join(dir, e)).catch(() => null);
      if (!st || !st.isFile()) continue;
      const ext = extname(e).toLowerCase();
      out.push({
        url: e,
        localPath: join(relDir, e),
        kind: kind === 'script' ? 'script'
          : ext === '.css' ? 'style'
          : ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(ext) ? 'image'
          : ['.woff', '.woff2', '.ttf'].includes(ext) ? 'font'
          : ['.mp4', '.webm'].includes(ext) ? 'video' : 'other',
        bytes: st.size,
      });
    }
  }
  return out;
}

/** Behavioral component inventory from captured page HTML (DOM-level, no bundle text). */
async function extractComponents(
  capDir: string,
  route: CapturedRoute,
  namer?: (kind: 'entity' | 'component', hint: string) => Promise<string>,
): Promise<SpecComponent[]> {
  // The capture stage stores routes.json; HTML text was measured but the DOM
  // inventory below works from a lightweight re-parse of saved page structure.
  // v1: derive components from the screenshot-adjacent metadata we recorded.
  // To stay honest about what we observed, we inventory from the live DOM at
  // capture time — capture.ts records htmlBytes; a fuller DOM walk happens
  // here from an optional dom.json sidecar if present.
  const comps: SpecComponent[] = [];
  const sidecar = join(capDir, 'dom', `${route.path.replace(/[^a-zA-Z0-9]+/g, '_') || 'root'}.json`);
  let dom: { tag: string; text?: string; count: number }[] = [];
  try {
    dom = JSON.parse(await readFile(sidecar, 'utf8')) as typeof dom;
  } catch {
    return comps; // no sidecar → empty inventory (honest, not invented)
  }
  const kindOf = (tag: string): SpecComponent['kind'] => {
    switch (tag.toLowerCase()) {
      case 'nav': return 'navbar';
      case 'h1': case 'h2': return 'heading';
      case 'form': return 'form';
      case 'input': case 'textarea': case 'select': return 'input';
      case 'button': return 'button';
      case 'ul': case 'ol': return 'list';
      case 'table': return 'table';
      case 'img': case 'video': return 'media';
      case 'footer': return 'footer';
      case 'dialog': return 'modal';
      default: return 'other';
    }
  };
  for (const el of dom) {
    let name = `${kindOf(el.tag)}-${el.tag}`;
    if (namer) {
      try {
        name = await namer('component', `${el.tag}: ${(el.text ?? '').slice(0, 60)}`);
      } catch { /* deterministic fallback */ }
    }
    comps.push({ name, kind: kindOf(el.tag), text: (el.text ?? '').slice(0, 500), count: el.count });
  }
  return comps;
}

/**
 * Unrecoverable gaps. Rule: anything security- or server-side that cannot be
 * observed from the client MUST be listed here with manual migration steps.
 * We never invent RLS policies, edge functions, triggers, or bucket configs.
 */
export function buildGaps(auth: SpecAuth, endpoints: SpecEndpoint[], thirdParty: SpecThirdParty[]): SpecGap[] {
  const gaps: SpecGap[] = [];
  const no = (category: SpecGap['category'], title: string, description: string, manualSteps: string[]): SpecGap =>
    ({ category, title, description, manualSteps, recoverable: false });

  if (auth.provider === 'supabase' || endpoints.some((e) => /\.supabase\.co/.test(e.url))) {
    gaps.push(no('rls-policy',
      'Supabase Row Level Security policies not recovered',
      'RLS policies live server-side and are invisible to client capture. The generated schema creates tables WITHOUT policies (locked down by default).',
      [
        'In your Supabase dashboard (self-hosted or cloud), open each table → Policies.',
        'Recreate the policies from your Lovable project\'s Supabase settings (export via the Supabase CLI: `supabase db dump --role-only` against the original project if you still have access).',
        'Test every policy with the app\'s real user roles before going live.',
      ]));
  }
  if (auth.provider !== 'none') {
    gaps.push(no('auth-config',
      'Auth configuration and user data not migrated',
      `Detected provider: ${auth.provider}. Client IDs are redacted; user tables, OAuth app registrations, and MFA settings cannot be exported by Unvibe.`,
      [
        'Create a new project on your own auth instance (self-hosted Supabase Auth or the same provider).',
        'Re-register OAuth providers (Google/GitHub/…) with new redirect URLs pointing at your domain.',
        'Migrate users via the provider\'s official export/import (e.g. Supabase Auth Admin API). Unvibe never automates user-table export — see docs/auth-migration-runbook.md in the output repo.',
      ]));
  }
  gaps.push(no('edge-function',
    'Edge/serverless functions not recovered',
    'Server-side functions (Supabase Edge Functions, Lovable server code) never ship to the browser; their behavior is unobservable from capture.',
    [
      'List your functions in the original project dashboard.',
      'Reimplement each as a route in server/ (stub files are generated) or as Supabase Edge Functions in supabase/functions/.',
      'Wire the frontend API client to the new function URLs and re-run `unvibe verify`.',
    ]));
  gaps.push(no('database-trigger',
    'Database triggers and scheduled jobs not recovered',
    'Triggers, cron jobs, and realtime subscriptions are server-side and invisible to client capture.',
    [
      'Export trigger definitions from the original database (`supabase db dump`) and re-apply them to your self-hosted Postgres.',
      'Recreate cron schedules in your new environment.',
    ]));
  const hasStorage = endpoints.some((e) => /storage|bucket/.test(e.url));
  gaps.push(no('storage-bucket',
    hasStorage ? 'Storage buckets partially observed — configs not recovered' : 'Storage bucket configs not recovered',
    'File URLs may appear in capture, but bucket policies, size limits, and MIME restrictions are server-side.',
    [
      'Recreate buckets in your Supabase storage (self-hosted) with matching names.',
      'Re-apply public/private policies per bucket; copy files over with the storage API.',
    ]));
  const payments = thirdParty.filter((t) => t.category === 'payments');
  if (payments.length > 0) {
    gaps.push(no('payment-flow',
      `Payment flows stubbed (${payments.map((p) => p.name).join(', ')})`,
      'Unvibe reconstructs payment UI as stubs only. Live payment flows require your own provider keys and webhook endpoints.',
      [
        'Create products/prices in your own Stripe (or equivalent) account.',
        'Set STRIPE_SECRET_KEY / webhook secret in the output repo\'s .env.',
        'Implement the webhook handler in server/ and test with the provider\'s CLI in test mode.',
      ]));
  }
  gaps.push(no('secret',
    'Secrets and API keys not migrated',
    'Keys are redacted during capture. Every integration needs fresh credentials.',
    [
      'Copy .env.example to .env and fill in keys for YOUR instances.',
      'Rotate any key that was ever embedded in the original client bundle.',
    ]));
  return gaps;
}
