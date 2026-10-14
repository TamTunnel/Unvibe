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
      { path: '/', title: 'Home', screenshot: 'screenshots/a.png', outgoingLinks: [], components: [], apiCalls: ['ep-1'] },
      { path: '/about', title: 'About', screenshot: 'screenshots/b.png', outgoingLinks: [], components: [], apiCalls: [] },
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
      source: 'har-payload', evidence: [],
    }],
    assets: [],
    auth: { provider: 'none', evidence: [] },
    thirdParty: [],
    gaps: [],
    stats: { pagesVisited: 2, requestsCaptured: 1, scriptsAnalyzed: 0 },
  });
}

describe('contractTests (static layer)', () => {
  it('passes when the regenerated repo covers the spec', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'unvibe-contracts-'));
    await mkdir(join(dir, 'src/lib'), { recursive: true });
    await writeFile(join(dir, 'src/lib/api.ts'), `
      import { apiRequest } from "./http";
      export async function callEp1() { return apiRequest("GET", "/api/projects", {}); }
    `);
    await writeFile(join(dir, 'src/types.ts'), `
      export interface Project { id: string; name: string; }
    `);
    await writeFile(join(dir, 'src/App.tsx'), `
      <Route path="/" element={<HomePage />} />
      <Route path="/about" element={<AboutPage />} />
    `);
    await mkdir(join(dir, 'src/pages'), { recursive: true });
    await writeFile(join(dir, 'src/pages/home.tsx'), `export default function HomePage() { return <main><h1>Home</h1></main>; }`);
    await writeFile(join(dir, 'src/pages/about.tsx'), `export default function AboutPage() { return <main><h1>About</h1></main>; }`);
    const r = await contractTests({ spec: spec(), outputDir: dir, onProgress: () => {} });
    expect(r.checks.length).toBeGreaterThan(0);
    expect(r.pass).toBe(true);
  });

  it('fails when an endpoint has no call-site in the api client', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'unvibe-contracts-'));
    await mkdir(join(dir, 'src/lib'), { recursive: true });
    await writeFile(join(dir, 'src/lib/api.ts'), `export async function unrelated() { return 1; }`);
    await writeFile(join(dir, 'src/types.ts'), `export interface Project { id: string; name: string; }`);
    await writeFile(join(dir, 'src/App.tsx'), `<Route path="/" element={<HomePage />} /><Route path="/about" element={<AboutPage />} />`);
    await mkdir(join(dir, 'src/pages'), { recursive: true });
    await writeFile(join(dir, 'src/pages/home.tsx'), `export default function HomePage() { return <main><h1>Home</h1></main>; }`);
    await writeFile(join(dir, 'src/pages/about.tsx'), `export default function AboutPage() { return <main><h1>About</h1></main>; }`);
    const r = await contractTests({ spec: spec(), outputDir: dir, onProgress: () => {} });
    expect(r.pass).toBe(false);
    expect(r.checks.some((c) => !c.pass && c.name.includes('/api/projects'))).toBe(true);
  });

  it('fails when a route has no generated page (not the scaffold App.tsx)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'unvibe-contracts-'));
    await mkdir(join(dir, 'src/lib'), { recursive: true });
    await writeFile(join(dir, 'src/lib/api.ts'), `apiRequest("GET", "/api/projects", {})`);
    await writeFile(join(dir, 'src/types.ts'), `export interface Project { id: string; name: string; }`);
    await writeFile(join(dir, 'src/App.tsx'), `<Route path="/" element={<HomePage />} />`);
    await mkdir(join(dir, 'src/pages'), { recursive: true });
    await writeFile(join(dir, 'src/pages/home.tsx'), `export default function HomePage() { return <main><h1>Home</h1></main>; }`);
    // NOTE: src/App.tsx still wires /about (scaffold), but no GENERATED page exists → must fail.
    const r = await contractTests({ spec: spec(), outputDir: dir, onProgress: () => {} });
    expect(r.pass).toBe(false);
    expect(r.checks.some((c) => !c.pass && c.name.includes('/about'))).toBe(true);
  });
});
