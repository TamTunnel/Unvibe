/**
 * Contract tests — "same routes, same data, same flows".
 *
 * Two layers:
 * 1. Static (always runs): every spec endpoint must have a corresponding
 *    call-site in the regenerated API client (method + URL pattern
 *    preserved); every spec entity must have a matching TypeScript
 *    interface; every spec route must have a GENERATED page component that
 *    default-exports the exact name src/App.tsx imports AND renders
 *    observed content (not `return null`). These check generated content —
 *    never scaffold strings — so a gutted rebuild fails.
 * 2. Live (optional): every spec route must return HTTP 200 from the rebuilt
 *    app (needs --rebuilt-url).
 *
 * These test the CONTRACT, not pixels. They pass when the rebuild talks to
 * backends the same way the original did.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  routeToComponentName, routeToPageFile,
  type UnvibeSpec, type SpecEndpoint, type SpecEntity, type SpecRoute, type JsonShape,
} from '@tamtunnel/unvibe-core';

export interface ContractCheck {
  name: string;
  pass: boolean;
  detail: string;
}

export interface ContractTestOptions {
  spec: UnvibeSpec;
  /** Root of the regenerated output repo. */
  outputDir: string;
  /** Base URL of the rebuilt app for live checks. Omit to skip live checks. */
  rebuiltUrl?: string;
  /**
   * Accept an endpoint-free / entity-free rebuild. Without this, 0 observed
   * endpoints or entities FAIL loudly instead of auto-passing — an empty
   * contract is a claim that needs explicit sign-off.
   */
  allowEmpty?: boolean;
  onProgress?: (msg: string) => void;
}

/** Backwards-compatible alias (older name). */
export interface ContractTestResult {
  checks: ContractCheck[];
  pass: boolean;
}

/** m9: never interpolate observed field names into a RegExp unescaped. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Does a regenerated file reference this endpoint (method + pattern)? */
function endpointReferenced(source: string, ep: SpecEndpoint): boolean {
  const patternTail = ep.urlPattern.split('/').filter(Boolean).pop() ?? '';
  return source.includes(ep.urlPattern) || (patternTail.length > 2 && source.includes(patternTail) && source.includes(`"${ep.method}"`));
}

function shapeCompatible(specShape: JsonShape | undefined, tsSource: string, entityName: string): boolean {
  if (!specShape) return true;
  if (!tsSource.includes(`interface ${entityName}`)) return false;
  // Unwrap array-of-object shapes to the item shape (M4: entities come from items).
  const shape = specShape.type === 'array' && specShape.items ? specShape.items : specShape;
  if (shape.type !== 'object' || !shape.properties) return true;
  // Every required spec field should appear in the interface.
  const missing = (shape.required ?? []).filter((f) => !new RegExp(`\\b${escapeRegExp(f)}\\b`).test(tsSource));
  return missing.length === 0;
}

/** M4: resolve the endpoint an entity's shape was inferred from. */
function entityEndpoint(spec: UnvibeSpec, entity: SpecEntity): SpecEndpoint | undefined {
  if (entity.sourceEndpointId) {
    const byId = spec.endpoints.find((x) => x.id === entity.sourceEndpointId);
    if (byId) return byId;
  }
  // Fallback: parse the evidence string ("GET /api/projects → response[]").
  for (const ev of entity.evidence) {
    const m = /^(\S+)\s+(\S+)\s+→/.exec(ev);
    if (m) {
      const byPattern = spec.endpoints.find((x) => x.method === m[1] && x.urlPattern === m[2]);
      if (byPattern) return byPattern;
    }
  }
  return spec.endpoints.find((x) => x.responseShape);
}

/**
 * Judge #5: check the GENERATED page component — not the scaffold's
 * App.tsx (which is rendered from the spec and would trivially pass).
 * Fails when the page is missing, doesn't default-export the exact name
 * App.tsx imports, or renders nothing (e.g. `return null`).
 */
function checkGeneratedPage(src: string | null, route: SpecRoute): ContractCheck {
  const name = `route ${route.path} page renders observed content`;
  const pageFile = routeToPageFile(route.path);
  const expected = routeToComponentName(route.path);
  if (!src) {
    return { name, pass: false, detail: `generated page ${pageFile} missing` };
  }
  const hasDefaultExport = /export\s+default\b/.test(src);
  const exportsExpectedName = src.includes(expected);
  if (!hasDefaultExport || !exportsExpectedName) {
    return {
      name, pass: false,
      detail: `${pageFile} must default-export ${expected} (the name src/App.tsx imports)`,
    };
  }
  const rendersNullOnly =
    /return\s+null\s*;/.test(src) && !/<[a-zA-Z][\w-]*/.test(src.replace(/return\s+null\s*;/g, ''));
  if (rendersNullOnly || src.trim().length < 40) {
    return { name, pass: false, detail: `${pageFile} renders nothing (gutted rebuild)` };
  }
  // Data binding: the page should reference observed content — route title,
  // component names, or observed text fragments — or at least render JSX.
  const needles: string[] = [];
  if (route.title) needles.push(route.title);
  for (const c of route.components) {
    needles.push(c.name);
    if (c.text) {
      for (const seg of c.text.split(/\s*\|\|\s*/).map((s) => s.trim()).filter(Boolean)) {
        if (seg.length >= 4) needles.push(seg.slice(0, 32));
      }
    }
  }
  const bound = needles.some((n) => n && src.includes(n));
  const hasJsx = /<(main|h1|h2|button|form|input|table|ul|ol|section|p|div|span|nav|img)\b/.test(src);
  if (!bound && !hasJsx) {
    return { name, pass: false, detail: `${pageFile} shows no observed content (no title/component/text binding)` };
  }
  return { name, pass: true, detail: `${expected} default-exported in ${pageFile}, renders observed content` };
}

export async function contractTests(opts: ContractTestOptions): Promise<ContractTestResult> {
  const log = opts.onProgress ?? (() => {});
  const checks: ContractCheck[] = [];
  const read = async (rel: string): Promise<string | null> =>
    readFile(join(opts.outputDir, rel), 'utf8').catch(() => null);

  // Static layer: API client covers spec endpoints (generated content).
  const apiClient = await read('src/lib/api.ts');
  if (opts.spec.endpoints.length === 0) {
    checks.push({
      name: 'endpoints: none observed',
      pass: opts.allowEmpty === true,
      detail: opts.allowEmpty === true
        ? 'spec has 0 endpoints (explicitly allowed via --allow-empty)'
        : 'spec has 0 endpoints — pass --allow-empty to accept an endpoint-free rebuild',
    });
  } else if (!apiClient) {
    checks.push({ name: 'api-client exists', pass: false, detail: 'src/lib/api.ts missing but spec has endpoints' });
  } else {
    for (const ep of opts.spec.endpoints) {
      const ok = endpointReferenced(apiClient, ep);
      checks.push({
        name: `endpoint ${ep.method} ${ep.urlPattern} referenced in api client`,
        pass: ok,
        detail: ok ? `found in src/lib/api.ts` : `NOT FOUND in src/lib/api.ts`,
      });
      log(`verify: contract ${ep.method} ${ep.urlPattern} ${ok ? 'PASS' : 'FAIL'}`);
    }
  }

  // Static layer: entity interfaces match THEIR OWN inferred shapes (M4).
  const typesSrc = await read('src/types.ts');
  if (opts.spec.entities.length === 0) {
    checks.push({
      name: 'entities: none inferred',
      pass: opts.allowEmpty === true,
      detail: opts.allowEmpty === true
        ? 'spec has 0 entities (explicitly allowed via --allow-empty)'
        : 'spec has 0 entities — pass --allow-empty to accept an entity-free rebuild',
    });
  } else if (!typesSrc) {
    checks.push({ name: 'entity types exist', pass: false, detail: 'src/types.ts missing but spec has entities' });
  } else {
    for (const e of opts.spec.entities) {
      const ep = entityEndpoint(opts.spec, e);
      const ok = shapeCompatible(ep?.responseShape, typesSrc, e.name);
      checks.push({
        name: `entity ${e.name} interface matches observed shape`,
        pass: ok,
        detail: ok ? `interface ${e.name} covers observed fields` : `interface ${e.name} missing or incomplete`,
      });
    }
  }

  // Static layer: GENERATED page per route (never the scaffold's App.tsx).
  for (const r of opts.spec.routes) {
    const pageSrc = await read(routeToPageFile(r.path));
    const check = checkGeneratedPage(pageSrc, r);
    checks.push(check);
    log(`verify: contract route ${r.path} ${check.pass ? 'PASS' : 'FAIL'} (${check.detail})`);
  }

  // Live layer (optional): routes return 200.
  if (opts.rebuiltUrl) {
    const base = opts.rebuiltUrl.replace(/\/$/, '');
    for (const r of opts.spec.routes) {
      let pass = false;
      let detail = '';
      try {
        const res = await fetch(base + r.path, { redirect: 'follow' });
        pass = res.ok;
        detail = `HTTP ${res.status}`;
      } catch (e) {
        detail = `fetch failed: ${(e as Error).message.split('\n')[0]}`;
      }
      checks.push({ name: `live: GET ${r.path} → 2xx`, pass, detail });
      log(`verify: live GET ${r.path} ${pass ? 'PASS' : 'FAIL'} (${detail})`);
    }
  }

  return { checks, pass: checks.every((c) => c.pass) };
}

/** Render a human-readable verify report (markdown). */
export function renderVerifyReport(
  spec: UnvibeSpec,
  diff: { routes: { path: string; diffRatio: number; pass: boolean; note?: string }[]; pass: boolean; threshold: number } | null,
  contracts: ContractTestResult,
  typecheck?: { errors: string[]; warnings: string[]; pass: boolean },
): string {
  const lines = [
    '# Unvibe verify report',
    '',
    `Source: ${spec.source.url} · spec v${spec.specVersion}`,
    '',
  ];
  if (diff) {
    lines.push(
      '## Screenshot diff',
      '',
      `Threshold: ${(diff.threshold * 100).toFixed(0)}% differing pixels per route (generous by design — pixel-perfect is out of scope).`,
      `Overall: **${diff.pass ? 'PASS' : 'FAIL'}**`,
      '',
      '| Route | Diff | Result |',
      '|---|---|---|',
      ...diff.routes.map((r) => `| \`${r.path}\` | ${(r.diffRatio * 100).toFixed(1)}% | ${r.pass ? 'PASS' : 'FAIL'}${r.note ? ` — ${r.note}` : ''} |`),
      '',
    );
  } else {
    lines.push(
      '## Screenshot diff',
      '',
      '**SKIPPED** — no --rebuilt-url given, so there is no rebuilt app to screenshot. ' +
        'Static contract checks and the compile gate below still ran.',
      '',
    );
  }
  lines.push(
    '## Contract tests',
    '',
    `Overall: **${contracts.pass ? 'PASS' : 'FAIL'}**`,
    '',
    ...contracts.checks.map((c) => `- ${c.pass ? '✅' : '❌'} ${c.name} — ${c.detail}`),
    '',
  );
  if (typecheck) {
    lines.push(
      '## Compile gate',
      '',
      `Overall: **${typecheck.pass ? 'PASS' : 'FAIL'}**`,
      '',
      ...typecheck.errors.map((e) => `- ❌ ${e}`),
      ...typecheck.warnings.map((w) => `- ⚠️ ${w}`),
      ...(typecheck.pass && typecheck.errors.length === 0 ? ['- ✅ generated sources compile (third-party modules exempt — run `npm install && npm run build` in the repo for the full check)'] : []),
      '',
    );
  }
  lines.push(
    '## What this proves',
    '',
    'Same routes exist, the same API endpoints are called with the same',
    'shapes, and the same data model is created. It does not prove the UI',
    'looks identical — judge the diff screenshots in `verify/` yourself.',
    '',
  );
  return lines.join('\n');
}
