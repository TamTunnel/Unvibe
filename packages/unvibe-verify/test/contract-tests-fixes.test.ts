import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contractTests } from '../src/contract-tests.js';
import { parseSpec, type UnvibeSpec } from '@tamtunnel/unvibe-core';

function spec(): UnvibeSpec {
  return parseSpec({
    specVersion: '1.0.0',
    source: { platform: 'lovable', url: 'https://demo.lovable.app', capturedAt: new Date().toISOString(), unvibeVersion: '0.1.0' },
    ownership: { attestedAt: new Date().toISOString(), method: 'flag' },
    routes: [
      {
        path: '/', title: 'Home', screenshot: 'screenshots/a.png', outgoingLinks: [],
        components: [{ name: 'HeroHeading', kind: 'hero', text: 'Welcome home', count: 1 }],
        apiCalls: [],
      },
    ],
    endpoints: [{
      id: 'ep-1', method: 'GET', url: 'https://demo.lovable.app/api/projects',
      urlPattern: '/api/projects', origin: 'har', sampleCount: 1, routes: ['/'],
      responseShape: {
        type: 'array',
        items: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' }, name: { type: 'string' } },
          required: ['id', 'name'],
        },
      },
    }],
    entities: [{
      name: 'Project', tableName: 'projects',
      fields: [
        { name: 'id', type: 'uuid', nullable: false },
        { name: 'name', type: 'string', nullable: false },
      ],
      source: 'har-payload', sourceEndpointId: 'ep-1', evidence: ['GET /api/projects → response[]'],
    }],
    assets: [],
    auth: { provider: 'none', evidence: [] },
    thirdParty: [],
    gaps: [],
    stats: { pagesVisited: 1, requestsCaptured: 1, scriptsAnalyzed: 0 },
  });
}

async function writeRepo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'unvibe-contracts-'));
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(join(dir, rel.split('/').slice(0, -1).join('/')), { recursive: true });
    await writeFile(join(dir, rel), content);
  }
  return dir;
}

const GOOD_PAGE = `export default function HomePage() {
  return (
    <main>
      <section className="hero" aria-label="HeroHeading">
        <h1 className="hero">Welcome home</h1>
      </section>
    </main>
  );
}
`;

/**
 * Judge #5 regression tests: the verify gate must be meaningful — it checks
 * GENERATED content, never scaffold strings.
 */
describe('contractTests against generated content (Judge #5)', () => {
  it('fails a gutted rebuild (page returns null)', async () => {
    const dir = await writeRepo({
      'src/pages/home.tsx': 'export default function HomePage() { return null; }\n',
    });
    const r = await contractTests({ spec: spec(), outputDir: dir, allowEmpty: true, onProgress: () => {} });
    const routeCheck = r.checks.find((c) => c.name.startsWith('route /'));
    expect(routeCheck?.pass).toBe(false);
    expect(routeCheck?.detail).toMatch(/renders nothing|gutted/i);
    expect(r.pass).toBe(false);
  });

  it('fails when the generated page is missing', async () => {
    const dir = await writeRepo({});
    const r = await contractTests({ spec: spec(), outputDir: dir, allowEmpty: true, onProgress: () => {} });
    expect(r.checks.find((c) => c.name.startsWith('route /'))?.pass).toBe(false);
    expect(r.pass).toBe(false);
  });

  it('fails when the page does not default-export the exact App.tsx contract name', async () => {
    const dir = await writeRepo({
      'src/pages/home.tsx': 'export function WrongName() { return <main><h1>Welcome home</h1></main>; }\n',
    });
    const r = await contractTests({ spec: spec(), outputDir: dir, allowEmpty: true, onProgress: () => {} });
    expect(r.checks.find((c) => c.name.startsWith('route /'))?.pass).toBe(false);
    expect(r.pass).toBe(false);
  });

  it('passes a genuine generated page', async () => {
    const dir = await writeRepo({ 'src/pages/home.tsx': GOOD_PAGE });
    const r = await contractTests({ spec: spec(), outputDir: dir, allowEmpty: true, onProgress: () => {} });
    expect(r.checks.find((c) => c.name.startsWith('route /'))?.pass).toBe(true);
  });

  it('0 endpoints fail loudly without --allow-empty, pass with it', async () => {
    const s = spec();
    (s as { endpoints: unknown[] }).endpoints = [];
    const dir = await writeRepo({ 'src/pages/home.tsx': GOOD_PAGE });
    const strict = await contractTests({ spec: s, outputDir: dir, onProgress: () => {} });
    expect(strict.checks.find((c) => c.name.startsWith('endpoints:'))?.pass).toBe(false);
    expect(strict.pass).toBe(false);
    const allowed = await contractTests({ spec: s, outputDir: dir, allowEmpty: true, onProgress: () => {} });
    expect(allowed.checks.find((c) => c.name.startsWith('endpoints:'))?.pass).toBe(true);
  });

  it('0 entities fail loudly without --allow-empty', async () => {
    const s = spec();
    (s as { entities: unknown[] }).entities = [];
    const dir = await writeRepo({ 'src/pages/home.tsx': GOOD_PAGE });
    const strict = await contractTests({ spec: s, outputDir: dir, onProgress: () => {} });
    expect(strict.checks.find((c) => c.name.startsWith('entities:'))?.pass).toBe(false);
  });
});

describe('entity→endpoint resolution (M4)', () => {
  it('checks each entity against its OWN endpoint shape, not the first', async () => {
    const s = spec();
    s.endpoints.push({
      id: 'ep-2', method: 'GET', url: 'https://demo.lovable.app/api/orders',
      urlPattern: '/api/orders', origin: 'har', sampleCount: 1, routes: [],
      responseShape: {
        type: 'object',
        properties: { total: { type: 'number' } },
        required: ['total'],
      },
    });
    s.entities.push({
      name: 'Order', tableName: 'orders',
      fields: [{ name: 'total', type: 'number', nullable: false }],
      source: 'har-payload', sourceEndpointId: 'ep-2', evidence: ['GET /api/orders → response'],
    });
    const dir = await writeRepo({
      'src/pages/home.tsx': GOOD_PAGE,
      'src/lib/api.ts': 'import { apiRequest } from "./http";\nexport async function callEp1(p = {}, b) { return apiRequest("GET", "/api/projects", p, b); }\nexport async function callEp2(p = {}, b) { return apiRequest("GET", "/api/orders", p, b); }\n',
      // types.ts covers BOTH entities' own shapes.
      'src/types.ts': 'export interface Project { id: string; name: string; }\nexport interface Order { total: number; }\n',
    });
    const r = await contractTests({ spec: s, outputDir: dir, onProgress: () => {} });
    expect(r.checks.find((c) => c.name.includes('Project'))?.pass).toBe(true);
    expect(r.checks.find((c) => c.name.includes('Order'))?.pass).toBe(true);
    expect(r.pass).toBe(true);
  });
});

describe('field-name regex escaping (m9)', () => {
  it('does not crash on regex-special field names', async () => {
    const s = spec();
    s.entities[0].fields.push({ name: 'price.usd (est)', type: 'string', nullable: true });
    const shape = s.endpoints[0].responseShape as { items: { required: string[] } };
    shape.items.required.push('price.usd (est)');
    const dir = await writeRepo({
      'src/pages/home.tsx': GOOD_PAGE,
      'src/types.ts': 'export interface Project { id: string; name: string; }\n',
    });
    const r = await contractTests({ spec: s, outputDir: dir, allowEmpty: true, onProgress: () => {} });
    const check = r.checks.find((c) => c.name.includes('Project'));
    // Missing field → clean FAIL, not a RegExp crash.
    expect(check?.pass).toBe(false);
    expect(check?.detail).toMatch(/missing or incomplete/);
  });
});
