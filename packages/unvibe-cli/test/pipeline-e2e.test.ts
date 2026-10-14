import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPipeline, stagePaths } from '../src/pipeline.js';
import { contractTests } from '@tamtunnel/unvibe-verify';

const FIXTURE = new URL('../../../fixtures/fixture-app/server.mjs', import.meta.url);
const PORT = 8902;

/**
 * Full pipeline e2e against the synthetic fixture app:
 * capture → analyze → regenerate (mock LLM) → contract tests.
 * Asserts the honest-recovery invariants end to end.
 */
describe('pipeline e2e (fixture app, mock LLM)', () => {
  let proc: ChildProcess;
  let workDir: string;

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
    workDir = await mkdtemp(join(tmpdir(), 'unvibe-e2e-'));
  }, 30000);

  afterAll(async () => {
    proc?.kill('SIGTERM');
  });

  it('runs capture → analyze → regenerate and produces an honest output repo', async () => {
    const { spec, verifyPass } = await runPipeline({
      url: `http://localhost:${PORT}/`,
      workDir,
      ownership: { attestedAt: new Date().toISOString(), method: 'flag' },
      llm: { provider: 'mock', model: 'mock-spec-codegen-v1' },
      reaMode: 'off', // hermetic: local fallback only
      onProgress: () => {},
    });
    expect(verifyPass).toBe(true); // no rebuilt URL → verify skipped → pass

    // Spec invariants.
    expect(spec.routes.map((r) => r.path).sort()).toEqual(['/', '/about', '/dashboard']);
    expect(spec.endpoints.length).toBeGreaterThan(0);
    expect(spec.endpoints.some((e) => e.urlPattern === '/api/projects')).toBe(true);
    // Data model inferred from observed payloads only.
    const project = spec.entities.find((e) => e.tableName === 'projects');
    expect(project).toBeDefined();
    expect(project!.fields.map((f) => f.name)).toContain('name');
    expect(project!.source).toBe('har-payload');
    // Auth detection via bundle markers.
    expect(spec.auth.provider).toBe('supabase');
    // Gaps are honest.
    expect(spec.gaps.some((g) => g.category === 'rls-policy')).toBe(true);
    expect(spec.gaps.every((g) => g.recoverable === false)).toBe(true);

    // Output repo invariants.
    const paths = stagePaths(workDir);
    const repoFiles = await readdir(paths.repoDir);
    for (const f of ['BACKEND-GAPS.md', 'unvibe-spec.json', 'docker-compose.yml', 'Dockerfile', 'src/App.tsx', 'src/lib/api.ts', 'src/types.ts', 'drizzle/schema.ts', 'supabase/migrations/0001_unvibe.sql']) {
      expect(repoFiles.includes(f) || await exists(join(paths.repoDir, f)), `missing ${f}`).toBe(true);
    }
    const gaps = await readFile(join(paths.repoDir, 'BACKEND-GAPS.md'), 'utf8');
    expect(gaps).toMatch(/Row Level Security/i);
    expect(gaps).toMatch(/not recovered|could \*\*not\*\* recover/i);
    const migration = await readFile(join(paths.repoDir, 'supabase/migrations/0001_unvibe.sql'), 'utf8');
    expect(migration).toContain('create table if not exists "projects"');

    // Clean-room: no fixture marker strings anywhere in the output repo.
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const grep = await promisify(execFile)('grep', ['-r', '__UNVIBE_CLEANROOM_MARKER_', paths.repoDir]).catch((e) => e);
    expect(String(grep.stdout ?? '')).toBe('');

    // Contract tests pass against the regenerated repo.
    const contracts = await contractTests({ spec, outputDir: paths.repoDir, onProgress: () => {} });
    expect(contracts.checks.length).toBeGreaterThan(0);
    expect(contracts.pass).toBe(true);
  }, 180000);
});

async function exists(p: string): Promise<boolean> {
  try {
    await readFile(p);
    return true;
  } catch {
    return false;
  }
}
