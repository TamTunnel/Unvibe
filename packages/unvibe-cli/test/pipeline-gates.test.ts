import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runPipeline, stagePaths, loadSpec, stageAnalyze, stageRegenerate, type RunOptions,
} from '../src/pipeline.js';
import {
  parseSpec, buildIntegrityRecord, stripUrlCredentials, checkUrlMatchesSpec,
  GateRefusal, type UnvibeSpec,
} from '@tamtunnel/unvibe-core';

const ATT = { attestedAt: new Date().toISOString(), method: 'flag' } as const;
const URL = 'https://demo.lovable.app';

function baseOpts(workDir: string, over: Partial<RunOptions> = {}): RunOptions {
  return {
    url: URL,
    workDir,
    ownership: { ...ATT },
    llm: { provider: 'mock', model: 'mock-spec-codegen-v1' },
    onProgress: () => {},
    ...over,
  };
}

function testSpec(): UnvibeSpec {
  return parseSpec({
    specVersion: '1.0.0',
    source: { platform: 'lovable', url: URL, capturedAt: new Date().toISOString(), unvibeVersion: '0.1.0' },
    ownership: { attestedAt: new Date().toISOString(), method: 'flag' },
    routes: [{
      path: '/', title: 'Home', screenshot: 'screenshots/route-0.png', outgoingLinks: [],
      components: [], apiCalls: [],
    }],
    endpoints: [], entities: [], assets: [],
    auth: { provider: 'none', evidence: [] },
    thirdParty: [], gaps: [],
    stats: { pagesVisited: 1, requestsCaptured: 0, scriptsAnalyzed: 0 },
  });
}

describe('pipeline gates (B2)', () => {
  it('runPipeline refuses without a validated attestation (no browser launched)', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'unvibe-gate-'));
    await expect(runPipeline(baseOpts(workDir, { ownership: undefined as never })))
      .rejects.toThrow(/attestation/i);
    await expect(runPipeline(baseOpts(workDir, { ownership: { method: 'flag' } as never })))
      .rejects.toThrow(/attestation/i);
  });

  it('runPipeline enforces target scope even with an attestation', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'unvibe-gate-'));
    await expect(runPipeline(baseOpts(workDir, { url: 'https://evil.example.com' })))
      .rejects.toThrow(GateRefusal);
  });

  it('runPipeline refuses circumvention-shaped targets', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'unvibe-gate-'));
    await expect(runPipeline(baseOpts(workDir, { url: 'https://x.lovable.app/drm-crack-tool' })))
      .rejects.toThrow(/circumvention/i);
  });
});

describe('spec integrity (Judge #6)', () => {
  async function writeSealedSpec(workDir: string, spec: UnvibeSpec): Promise<void> {
    const paths = stagePaths(workDir);
    await mkdir(join(workDir, '.unvibe'), { recursive: true });
    await writeFile(paths.specPath, JSON.stringify(spec, null, 2));
    await writeFile(paths.integrityPath, JSON.stringify(buildIntegrityRecord(spec), null, 2));
  }

  it('loadSpec accepts an intact sealed spec', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'unvibe-int-'));
    await writeSealedSpec(workDir, testSpec());
    const spec = await loadSpec(stagePaths(workDir));
    expect(spec.source.url).toBe(URL);
  });

  it('loadSpec refuses a tampered spec (gaps deleted, url forged)', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'unvibe-int-'));
    const spec = testSpec();
    await writeSealedSpec(workDir, spec);
    const paths = stagePaths(workDir);
    const tampered = { ...JSON.parse(await readFile(paths.specPath, 'utf8')), gaps: [] };
    tampered.source.url = 'https://forged.lovable.app';
    await writeFile(paths.specPath, JSON.stringify(tampered, null, 2));
    await expect(loadSpec(paths)).rejects.toThrow(/integrity mismatch/i);
  });

  it('loadSpec refuses when the integrity file is missing', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'unvibe-int-'));
    const paths = stagePaths(workDir);
    await mkdir(join(workDir, '.unvibe'), { recursive: true });
    await writeFile(paths.specPath, JSON.stringify(testSpec(), null, 2));
    await expect(loadSpec(paths)).rejects.toThrow(/missing spec.integrity.json/i);
  });
});

describe('URL handling (Judge #3b / #6)', () => {
  it('stripUrlCredentials removes userinfo', () => {
    expect(stripUrlCredentials('https://user:pass@myapp.lovable.app/a?b=c'))
      .toBe('https://myapp.lovable.app/a?b=c');
    expect(stripUrlCredentials('https://myapp.lovable.app/a')).toBe('https://myapp.lovable.app/a');
  });

  it('checkUrlMatchesSpec refuses mismatched --url', () => {
    expect(() => checkUrlMatchesSpec('https://other.lovable.app', URL)).toThrow(/does not match/);
  });

  it('checkUrlMatchesSpec tolerates cosmetic differences', () => {
    expect(() => checkUrlMatchesSpec('https://demo.lovable.app/', URL)).not.toThrow();
    expect(() => checkUrlMatchesSpec('https://user:pass@demo.lovable.app', URL)).not.toThrow();
    expect(() => checkUrlMatchesSpec('https://DEMO.lovable.app', URL)).not.toThrow();
  });
});

describe('leak-scan skip banner (Judge #2d)', () => {
  it('stageRegenerate warns loudly when no bundle text is available', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'unvibe-leakskip-'));
    const paths = stagePaths(workDir);
    await mkdir(paths.captureDir, { recursive: true }); // no scripts/ dir
    const lines: string[] = [];
    await stageRegenerate(
      { ...baseOpts(workDir), onProgress: (m) => lines.push(m) },
      paths,
      testSpec(),
    );
    expect(lines.join('\n')).toMatch(/verbatim-leak scan SKIPPED/i);
    // And the scaffold still renders (spec/scaffold don't carry creds or bundle text).
    const readme = await readFile(join(paths.repoDir, 'README.md'), 'utf8');
    expect(readme).toContain(URL);
  });
});

describe('--i-own-this takes no value (Judge #8)', () => {
  it('the CLI rejects `--i-own-this 0` instead of attesting', async () => {
    const cli = new globalThis.URL('../dist/cli.js', import.meta.url).pathname;
    const proc = spawn(process.execPath, [cli, 'run', '--url', URL, '--i-own-this', '0'], { stdio: 'pipe' });
    let stderr = '';
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    const code: number = await new Promise((resolve) => proc.on('close', resolve));
    expect(code).toBe(2);
    expect(stderr).toMatch(/Unexpected argument.*--i-own-this takes no value/s);
  });
});

describe('URL credentials never persist (Judge #3b)', () => {
  it('stageAnalyze strips userinfo even for direct pipeline callers', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'unvibe-urlcreds-'));
    const paths = stagePaths(workDir);
    await mkdir(paths.captureDir, { recursive: true });
    await writeFile(join(paths.captureDir, 'capture.json'), JSON.stringify({
      outDir: paths.captureDir,
      origin: 'https://demo.lovable.app',
      routes: [{ path: '/', title: 'Home', screenshot: 'screenshots/a.png', outgoingLinks: [], htmlBytes: 10 }],
      harPath: 'capture.har',
      assetsDir: 'assets',
      screenshotsDir: 'screenshots',
      scriptsDir: 'scripts',
      requestCount: 0,
      routeRequests: {},
    }));
    const spec = await stageAnalyze(
      baseOpts(workDir, { url: 'https://user:s3cret@demo.lovable.app/' }),
      paths,
    );
    expect(spec.source.url).toBe('https://demo.lovable.app/');
    expect(JSON.stringify(spec)).not.toContain('s3cret');
  });
});
