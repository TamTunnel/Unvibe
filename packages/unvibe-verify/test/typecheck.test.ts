import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { typecheckOutputRepo } from '../src/typecheck.js';
import { regenerateFromSpec } from '@tamtunnel/unvibe-core';
import { MockLlmClient, parseSpec, type UnvibeSpec } from '@tamtunnel/unvibe-core';
import { renderScaffold } from '@tamtunnel/unvibe-templates';

/**
 * M6 regression tests: the verify gate fails when generated output doesn't
 * compile. Third-party modules (not installed at verify time) are warnings,
 * not failures — real syntax/type errors in project files fail.
 */
describe('typecheckOutputRepo', () => {
  it('fails on a syntax error in a generated file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'unvibe-tc-'));
    await mkdir(join(dir, 'src/pages'), { recursive: true });
    await writeFile(join(dir, 'src/pages/home.tsx'), 'export default function HomePage( { return <main>;\n');
    const r = await typecheckOutputRepo(dir);
    expect(r.pass).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it('fails on a type error within project files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'unvibe-tc-'));
    await mkdir(join(dir, 'src/lib'), { recursive: true });
    await writeFile(join(dir, 'src/lib/http.ts'), 'export async function apiRequest(): Promise<unknown> { return 1; }\n');
    await writeFile(
      join(dir, 'src/lib/api.ts'),
      'import { apiRequest } from "./http";\nexport async function callEp1(): Promise<string> { return apiRequest(); }\n',
    );
    const r = await typecheckOutputRepo(dir);
    expect(r.pass).toBe(false);
    expect(r.errors.some((e) => e.includes('api.ts'))).toBe(true);
  });

  it('treats missing third-party modules as warnings, not failures', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'unvibe-tc-'));
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(
      join(dir, 'src/App.tsx'),
      'import { BrowserRouter } from "react-router-dom";\nexport default function App() { return <BrowserRouter />; }\n',
    );
    const r = await typecheckOutputRepo(dir);
    expect(r.pass).toBe(true);
    expect(r.warnings.some((w) => w.includes('react-router-dom'))).toBe(true);
  });

  it('passes the mock-generated repo end to end (scaffold + generated)', async () => {
    const spec: UnvibeSpec = parseSpec({
      specVersion: '1.0.0',
      source: { platform: 'lovable', url: 'https://demo.lovable.app', capturedAt: new Date().toISOString(), unvibeVersion: '0.1.0' },
      ownership: { attestedAt: new Date().toISOString(), method: 'flag' },
      routes: [{
        path: '/', title: 'Home', screenshot: 'screenshots/a.png', outgoingLinks: [],
        components: [{ name: 'HeroHeading', kind: 'hero', text: 'Welcome home', count: 1 }],
        apiCalls: [],
      }],
      endpoints: [{
        id: 'ep-1', method: 'GET', url: 'https://demo.lovable.app/api/projects',
        urlPattern: '/api/projects', origin: 'har', sampleCount: 1, routes: ['/'],
      }],
      entities: [{
        name: 'Project', tableName: 'projects',
        fields: [{ name: 'id', type: 'uuid', nullable: false }, { name: 'name', type: 'string', nullable: false }],
        source: 'har-payload', evidence: [],
      }],
      assets: [],
      auth: { provider: 'none', evidence: [] },
      thirdParty: [], gaps: [],
      stats: { pagesVisited: 1, requestsCaptured: 1, scriptsAnalyzed: 0 },
    });
    const result = await regenerateFromSpec({
      spec, llm: new MockLlmClient(), scaffoldFiles: renderScaffold(spec), onProgress: () => {},
    });
    const dir = await mkdtemp(join(tmpdir(), 'unvibe-tc-'));
    for (const [rel, content] of Object.entries(result.files)) {
      await mkdir(join(dir, rel.split('/').slice(0, -1).join('/')), { recursive: true });
      await writeFile(join(dir, rel), content);
    }
    const r = await typecheckOutputRepo(dir);
    expect(r.errors).toEqual([]);
    expect(r.pass).toBe(true);
  }, 60000);
});
