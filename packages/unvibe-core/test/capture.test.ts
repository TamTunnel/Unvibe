import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureSite } from '../src/capture.js';

const FIXTURE = new URL('../../../fixtures/fixture-app/server.mjs', import.meta.url);
const PORT = 8901;

describe('capture (Playwright, deterministic)', () => {
  let proc: ChildProcess;
  let outDir: string;

  beforeAll(async () => {
    proc = spawn('node', [FIXTURE.pathname], {
      env: { ...process.env, FIXTURE_PORT: String(PORT) },
      stdio: 'pipe',
    });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('fixture app did not start')), 15000);
      proc.stdout?.on('data', (d: Buffer) => {
        if (d.toString().includes('listening')) { clearTimeout(t); resolve(); }
      });
      proc.on('error', reject);
    });
    outDir = await mkdtemp(join(tmpdir(), 'unvibe-capture-'));
  }, 30000);

  afterAll(async () => {
    proc?.kill('SIGTERM');
  });

  it('crawls routes, screenshots, HAR, and downloads scripts', async () => {
    const result = await captureSite({
      url: `http://localhost:${PORT}/`,
      outDir,
      maxPages: 10,
      onProgress: () => {},
    });
    expect(result.routes.map((r) => r.path).sort()).toEqual(['/', '/about', '/dashboard']);
    expect(result.routes.every((r) => r.title.length > 0)).toBe(true);

    // Screenshots exist for every route.
    for (const r of result.routes) {
      const buf = await readFile(join(outDir, r.screenshot));
      expect(buf.length).toBeGreaterThan(1000);
    }

    // HAR was recorded and contains the API calls.
    const har = JSON.parse(await readFile(join(outDir, result.harPath), 'utf8')) as {
      log: { entries: { request: { url: string } }[] };
    };
    const urls = har.log.entries.map((e) => e.request.url);
    expect(urls.some((u) => u.includes('/api/projects'))).toBe(true);

    // Scripts were downloaded for the REA adapter.
    const scripts = await readdir(join(outDir, result.scriptsDir));
    expect(scripts.some((s) => s.endsWith('.js'))).toBe(true);
    const bundleText = await readFile(join(outDir, result.scriptsDir, scripts.find((s) => s.endsWith('.js'))!), 'utf8');
    expect(bundleText).toContain('__UNVIBE_CLEANROOM_MARKER_A1B2C3__');

    // DOM inventory sidecars exist (behavioral only — no script contents).
    const domFiles = await readdir(join(outDir, 'dom'));
    expect(domFiles.length).toBe(3);
    const dom = JSON.parse(await readFile(join(outDir, 'dom', domFiles[0]), 'utf8')) as { tag: string }[];
    expect(dom.some((d) => d.tag === 'nav')).toBe(true);
  }, 90000);
});
