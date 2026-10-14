/**
 * Pipeline orchestration shared by the staged subcommands and `run`.
 *
 * Stage layout inside the work dir:
 *   <work>/.unvibe/capture/…      — capture artifacts
 *   <work>/.unvibe/unvibe-spec.json — the spec (checked into output repos)
 *   <work>/repo/…                 — regenerated output repo
 *   <work>/verify/…               — verify artifacts
 */
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  captureSite,
  analyzeCapture,
  regenerateFromSpec,
  renderBackendGaps,
  createLlmClient,
  parseSpec,
  type UnvibeSpec,
  type LlmConfig,
} from '@tamtunnel/unvibe-core';
import { renderScaffold } from '@tamtunnel/unvibe-templates';
import { screenshotDiff, contractTests, renderVerifyReport } from '@tamtunnel/unvibe-verify';
import type { OwnershipAttestation } from './gate.js';

export const UNVIBE_VERSION = '0.1.0';

export interface RunOptions {
  url: string;
  workDir: string;
  ownership: OwnershipAttestation;
  cookie?: string;
  maxPages?: number;
  llm: LlmConfig;
  /** Bundle-text leak scan needs the raw scripts; enabled by default. */
  leakScan?: boolean;
  verifyThreshold?: number;
  rebuiltUrl?: string;
  reaMode?: 'auto' | 'off';
  onProgress?: (msg: string) => void;
}

export interface StagePaths {
  captureDir: string;
  specPath: string;
  repoDir: string;
  verifyDir: string;
}

export function stagePaths(workDir: string): StagePaths {
  const dot = join(workDir, '.unvibe');
  return {
    captureDir: join(dot, 'capture'),
    specPath: join(dot, 'unvibe-spec.json'),
    repoDir: join(workDir, 'repo'),
    verifyDir: join(workDir, 'verify'),
  };
}

export async function stageCapture(opts: RunOptions, paths: StagePaths): Promise<void> {
  const log = opts.onProgress ?? (() => {});
  log('== stage: capture ==');
  const capture = await captureSite({
    url: opts.url,
    outDir: paths.captureDir,
    cookie: opts.cookie,
    maxPages: opts.maxPages,
    onProgress: log,
  });
  await writeFile(join(paths.captureDir, 'capture.json'), JSON.stringify(capture, null, 2));
}

export async function stageAnalyze(opts: RunOptions, paths: StagePaths): Promise<UnvibeSpec> {
  const log = opts.onProgress ?? (() => {});
  log('== stage: analyze ==');
  const capture = JSON.parse(await readFile(join(paths.captureDir, 'capture.json'), 'utf8'));
  const spec = await analyzeCapture({
    captureDir: paths.captureDir,
    capture,
    sourceUrl: opts.url,
    ownership: opts.ownership,
    unvibeVersion: UNVIBE_VERSION,
    reaMode: opts.reaMode,
    onProgress: log,
  });
  await writeFile(paths.specPath, JSON.stringify(spec, null, 2));
  log(`analyze: spec written to ${paths.specPath}`);
  return spec;
}

async function collectBundleText(captureDir: string): Promise<string> {
  // Raw script text is used ONLY for the post-hoc verbatim-leak scan.
  const dir = join(captureDir, 'scripts');
  let out = '';
  try {
    for (const e of await readdir(dir)) {
      if (!e.endsWith('.js')) continue;
      const text = await readFile(join(dir, e), 'utf8').catch(() => '');
      out += '\n' + text.slice(0, 200_000);
      if (out.length > 2_000_000) break;
    }
  } catch { /* no scripts dir */ }
  return out;
}

export async function stageRegenerate(opts: RunOptions, paths: StagePaths, spec: UnvibeSpec): Promise<void> {
  const log = opts.onProgress ?? (() => {});
  log('== stage: regenerate ==');
  const llm = createLlmClient(opts.llm);
  const scaffoldFiles = renderScaffold(spec);
  const bundleTextForLeakScan = opts.leakScan === false ? undefined : await collectBundleText(paths.captureDir);
  const result = await regenerateFromSpec({
    spec,
    llm,
    scaffoldFiles,
    bundleTextForLeakScan,
    onProgress: log,
  });
  if (result.leakFindings.length > 0) {
    throw new Error(
      `Clean-room violation: ${result.leakFindings.length} generated file(s) contain verbatim ` +
        `bundle text: ${result.leakFindings.map((f) => f.file).join(', ')}. Aborting — review before shipping.`,
    );
  }
  await mkdir(paths.repoDir, { recursive: true });
  for (const [rel, content] of Object.entries(result.files)) {
    const abs = join(paths.repoDir, rel);
    await mkdir(join(abs, '..'), { recursive: true }).catch(() => {});
    const { dirname } = await import('node:path');
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  await writeFile(join(paths.repoDir, 'BACKEND-GAPS.md'), renderBackendGaps(spec));
  log(`regenerate: ${Object.keys(result.files).length} files written to ${paths.repoDir} (prompt pack v${result.promptsVersion})`);
}

export async function stageVerify(opts: RunOptions, paths: StagePaths, spec: UnvibeSpec): Promise<boolean> {
  const log = opts.onProgress ?? (() => {});
  log('== stage: verify ==');
  const rebuiltBaseUrl = opts.rebuiltUrl;
  if (!rebuiltBaseUrl) {
    log('verify: skipped — no --rebuilt-url given');
    return true;
  }
  await mkdir(paths.verifyDir, { recursive: true });
  const diff = await screenshotDiff({
    spec,
    captureDir: paths.captureDir,
    rebuiltBaseUrl,
    outDir: paths.verifyDir,
    threshold: opts.verifyThreshold,
    onProgress: log,
  });
  const contracts = await contractTests({
    spec,
    outputDir: paths.repoDir,
    rebuiltBaseUrl,
    onProgress: log,
  });
  await writeFile(join(paths.verifyDir, 'report.md'), renderVerifyReport(spec, diff, contracts));
  await writeFile(join(paths.verifyDir, 'report.json'), JSON.stringify({ diff, contracts }, null, 2));
  const pass = diff.pass && contracts.pass;
  log(`verify: ${pass ? 'PASS' : 'FAIL'} (screenshots ${diff.pass ? 'pass' : 'fail'}, contracts ${contracts.pass ? 'pass' : 'fail'})`);
  return pass;
}

/** Full pipeline: capture → analyze → regenerate → verify. */
export async function runPipeline(opts: RunOptions): Promise<{ spec: UnvibeSpec; verifyPass: boolean }> {
  const paths = stagePaths(opts.workDir);
  await mkdir(opts.workDir, { recursive: true });
  await stageCapture(opts, paths);
  const spec = await stageAnalyze(opts, paths);
  await stageRegenerate(opts, paths, spec);
  const verifyPass = await stageVerify(opts, paths, spec);
  return { spec, verifyPass };
}

/** Load a spec from a previous analyze stage. */
export async function loadSpec(paths: StagePaths): Promise<UnvibeSpec> {
  return parseSpec(JSON.parse(await readFile(paths.specPath, 'utf8')));
}
