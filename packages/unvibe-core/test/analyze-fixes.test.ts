import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectAuth, tableToEntityName, buildGaps, analyzeCapture } from '../src/analyze.js';

/**
 * M1/M2 regression tests.
 */
describe('detectAuth (M1)', () => {
  it("returns 'none' (not 'unknown') when nothing auth-shaped is observed", () => {
    const auth = detectAuth([], ['https://demo.lovable.app/', 'https://demo.lovable.app/api/projects']);
    expect(auth.provider).toBe('none');
  });

  it('still detects providers from real evidence', () => {
    expect(detectAuth(['supabase'], []).provider).toBe('supabase');
    expect(detectAuth([], ['https://x.clerk.accounts.dev/v1']).provider).toBe('clerk');
  });

  it('no-auth capture yields no auth-config BACKEND-GAP', () => {
    const auth = detectAuth([], ['https://demo.lovable.app/api/projects']);
    const gaps = buildGaps(auth, [], []);
    expect(gaps.some((g) => g.category === 'auth-config')).toBe(false);
  });
});

describe('tableToEntityName (M2)', () => {
  it('pascal-cases table names (was: projects → Rojects)', () => {
    expect(tableToEntityName('projects')).toBe('Projects');
    expect(tableToEntityName('order_items')).toBe('OrderItems');
    expect(tableToEntityName('user')).toBe('User');
    expect(tableToEntityName('oauth2_tokens')).toBe('Oauth2Tokens');
  });
});

describe('endpoint→route attribution (M3)', () => {
  it('populates SpecRoute.apiCalls and endpoint.routes from per-route request logs', async () => {
    const capDir = await mkdtemp(join(tmpdir(), 'unvibe-m3-'));
    await mkdir(join(capDir, 'scripts'), { recursive: true });
    await mkdir(join(capDir, 'dom'), { recursive: true });
    await writeFile(join(capDir, 'capture.har'), JSON.stringify({
      log: {
        entries: [{
          request: { method: 'GET', url: 'https://demo.lovable.app/api/projects' },
          response: {
            status: 200,
            headers: [{ name: 'content-type', value: 'application/json' }],
            content: { mimeType: 'application/json', text: JSON.stringify([{ id: 1, name: 'A' }]) },
          },
        }],
      },
    }));
    const capture = {
      outDir: capDir,
      origin: 'https://demo.lovable.app',
      routes: [{ path: '/', title: 'Home', screenshot: 'screenshots/a.png', outgoingLinks: [], htmlBytes: 10 }],
      harPath: 'capture.har',
      assetsDir: 'assets',
      screenshotsDir: 'screenshots',
      scriptsDir: 'scripts',
      requestCount: 1,
      routeRequests: { '/': ['https://demo.lovable.app/api/projects'] },
    };
    const spec = await analyzeCapture({
      captureDir: capDir,
      capture,
      sourceUrl: 'https://demo.lovable.app',
      ownership: { attestedAt: new Date().toISOString(), method: 'flag' },
      unvibeVersion: '0.1.0',
      reaMode: 'off',
      onProgress: () => {},
    });
    expect(spec.endpoints).toHaveLength(1);
    expect(spec.endpoints[0].routes).toContain('/');
    expect(spec.routes[0].apiCalls).toEqual([spec.endpoints[0].id]);
  });
});
