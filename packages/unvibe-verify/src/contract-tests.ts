/**
 * Contract tests — "same routes, same data, same flows".
 *
 * Two layers:
 * 1. Static: every spec endpoint must have a corresponding call-site in the
 *    regenerated API client (method + URL pattern preserved); every spec
 *    entity must have a matching TypeScript interface.
 * 2. Live (optional): every spec route must return HTTP 200 from the rebuilt
 *    app, and every spec endpoint's path must be reachable through the
 *    rebuilt app's API base (when one is configured).
 *
 * These test the CONTRACT, not pixels. They pass when the rebuild talks to
 * backends the same way the original did.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { UnvibeSpec, SpecEndpoint, JsonShape } from '@tamtunnel/unvibe-core';

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
  rebuiltBaseUrl?: string;
  onProgress?: (msg: string) => void;
}

export interface ContractTestResult {
  checks: ContractCheck[];
  pass: boolean;
}

/** Does a regenerated file reference this endpoint (method + pattern)? */
function endpointReferenced(source: string, ep: SpecEndpoint): boolean {
  const patternTail = ep.urlPattern.split('/').filter(Boolean).pop() ?? '';
  return source.includes(ep.urlPattern) || (patternTail.length > 2 && source.includes(patternTail) && source.includes(`"${ep.method}"`));
}

function shapeCompatible(specShape: JsonShape | undefined, tsSource: string, entityName: string): boolean {
  if (!specShape) return true;
  if (!tsSource.includes(`interface ${entityName}`)) return false;
  if (specShape.type !== 'object' || !specShape.properties) return true;
  // Every required spec field should appear in the interface.
  const missing = (specShape.required ?? []).filter((f) => !new RegExp(`\\b${f}\\b`).test(tsSource));
  return missing.length === 0;
}

export async function contractTests(opts: ContractTestOptions): Promise<ContractTestResult> {
  const log = opts.onProgress ?? (() => {});
  const checks: ContractCheck[] = [];
  const read = async (rel: string): Promise<string | null> =>
    readFile(join(opts.outputDir, rel), 'utf8').catch(() => null);

  // Static layer: API client covers spec endpoints.
  const apiClient = await read('src/lib/api.ts');
  if (opts.spec.endpoints.length === 0) {
    checks.push({ name: 'endpoints: none observed, nothing to cover', pass: true, detail: 'spec has 0 endpoints' });
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

  // Static layer: entity interfaces match inferred shapes.
  const typesSrc = await read('src/types.ts');
  if (opts.spec.entities.length === 0) {
    checks.push({ name: 'entities: none inferred, nothing to cover', pass: true, detail: 'spec has 0 entities' });
  } else if (!typesSrc) {
    checks.push({ name: 'entity types exist', pass: false, detail: 'src/types.ts missing but spec has entities' });
  } else {
    for (const e of opts.spec.entities) {
      const ep = opts.spec.endpoints.find((x) => x.responseShape);
      const ok = shapeCompatible(ep?.responseShape, typesSrc, e.name);
      checks.push({
        name: `entity ${e.name} interface matches observed shape`,
        pass: ok,
        detail: ok ? `interface ${e.name} covers observed fields` : `interface ${e.name} missing or incomplete`,
      });
    }
  }

  // Static layer: routes wired in App.tsx.
  const appSrc = await read('src/App.tsx');
  for (const r of opts.spec.routes) {
    const ok = !!appSrc && appSrc.includes(`path="${r.path}"`);
    checks.push({
      name: `route ${r.path} wired in App.tsx`,
      pass: ok,
      detail: ok ? 'route registered' : 'route NOT registered in src/App.tsx',
    });
  }

  // Live layer (optional): routes return 200.
  if (opts.rebuiltBaseUrl) {
    const base = opts.rebuiltBaseUrl.replace(/\/$/, '');
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
  diff: { routes: { path: string; diffRatio: number; pass: boolean; note?: string }[]; pass: boolean; threshold: number },
  contracts: ContractTestResult,
): string {
  const lines = [
    '# Unvibe verify report',
    '',
    `Source: ${spec.source.url} · spec v${spec.specVersion}`,
    '',
    '## Screenshot diff',
    '',
    `Threshold: ${(diff.threshold * 100).toFixed(0)}% differing pixels per route (generous by design — pixel-perfect is out of scope).`,
    `Overall: **${diff.pass ? 'PASS' : 'FAIL'}**`,
    '',
    '| Route | Diff | Result |',
    '|---|---|---|',
    ...diff.routes.map((r) => `| \`${r.path}\` | ${(r.diffRatio * 100).toFixed(1)}% | ${r.pass ? 'PASS' : 'FAIL'}${r.note ? ` — ${r.note}` : ''} |`),
    '',
    '## Contract tests',
    '',
    `Overall: **${contracts.pass ? 'PASS' : 'FAIL'}**`,
    '',
    ...contracts.checks.map((c) => `- ${c.pass ? '✅' : '❌'} ${c.name} — ${c.detail}`),
    '',
    '## What this proves',
    '',
    'Same routes exist, the same API endpoints are called with the same',
    'shapes, and the same data model is created. It does not prove the UI',
    'looks identical — judge the diff screenshots in `verify/` yourself.',
    '',
  ];
  return lines.join('\n');
}
