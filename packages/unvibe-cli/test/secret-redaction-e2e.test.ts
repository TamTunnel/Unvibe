import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
  stageCapture, stageAnalyze, stageRegenerate, stagePaths,
} from '../src/pipeline.js';
import { MockLlmClient } from '@tamtunnel/unvibe-core';

const FIXTURE = new URL('../../../fixtures/fixture-app/server.mjs', import.meta.url);
const CANARY = 'sk_test_CANARY_DO_NOT_USE_0000';

/**
 * B1 end-to-end: the fixture API payload carries a synthetic canary secret
 * (session_token). It must appear NOWHERE in the spec, in any LLM prompt,
 * or in the output repo. (The raw HAR capture legitimately contains it —
 * that is the analyst's local evidence, never published.)
 */
describe('secret redaction end-to-end (B1)', () => {
  let proc: ChildProcess;
  let port = 0;

  beforeAll(async () => {
    process.env.UNVIBE_ALLOW_LOCALHOST = '1';
    proc = spawn('node', [FIXTURE.pathname], { stdio: 'pipe' });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('fixture app did not start')), 15000);
      proc.stdout?.on('data', (d: Buffer) => {
        const m = d.toString().match(/listening on http:\/\/localhost:(\d+)/);
        if (m) { port = Number(m[1]); clearTimeout(t); resolve(); }
      });
      proc.on('error', reject);
    });
  }, 30000);

  afterAll(async () => {
    proc?.kill('SIGTERM');
    delete process.env.UNVIBE_ALLOW_LOCALHOST;
  });

  it('canary secret appears in no spec, prompt, or output file', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'unvibe-b1-'));
    const paths = stagePaths(workDir);
    const log = () => {};
    const ownership = { attestedAt: new Date().toISOString(), method: 'flag' } as const;

    await stageCapture({
      url: `http://localhost:${port}/`, workDir, ownership,
      llm: { provider: 'mock', model: 'mock-spec-codegen-v1' },
      onProgress: log,
    }, paths);

    // Sanity: the canary really was captured (otherwise the test is vacuous).
    const har = await readFile(join(paths.captureDir, 'capture.har'), 'utf8');
    expect(har).toContain(CANARY);

    const spec = await stageAnalyze({
      url: `http://localhost:${port}/`, workDir, ownership,
      llm: { provider: 'mock', model: 'mock-spec-codegen-v1' },
      reaMode: 'off', onProgress: log,
    }, paths);

    // Spec: the field is observed, the value is masked.
    const specText = await readFile(paths.specPath, 'utf8');
    expect(specText).not.toContain(CANARY);
    expect(specText).toContain('session_token');
    expect(specText).toContain('"redacted": true');

    // Regenerate with a recording mock LLM (prompt assertions), then run the
    // real stageRegenerate (repo assertions).
    const llm = new MockLlmClient();
    const { regenerateFromSpec } = await import('@tamtunnel/unvibe-core');
    const { renderScaffold } = await import('@tamtunnel/unvibe-templates');
    await regenerateFromSpec({
      spec, llm, scaffoldFiles: renderScaffold(spec), onProgress: log,
    });

    // Prompts: canary in none of them.
    const promptBlob = llm.requests.map((msgs) => msgs.map((m) => m.content).join('\n')).join('\n');
    expect(promptBlob).not.toContain(CANARY);

    // Output repo: canary in no file.
    await stageRegenerate({
      url: `http://localhost:${port}/`, workDir, ownership,
      llm: { provider: 'mock', model: 'mock-spec-codegen-v1' },
      onProgress: log,
    }, paths, spec);
    const walk = async (dir: string): Promise<string[]> => {
      const out: string[] = [];
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) out.push(...await walk(p));
        else out.push(p);
      }
      return out;
    };
    for (const f of await walk(paths.repoDir)) {
      const text = await readFile(f, 'utf8').catch(() => '');
      expect(text, relative(paths.repoDir, f)).not.toContain(CANARY);
    }
  }, 180000);
});
