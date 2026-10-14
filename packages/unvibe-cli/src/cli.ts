#!/usr/bin/env node
/**
 * unvibe — an escape hatch for vibe-locked apps.
 *
 * Only processes apps you own: every command requires --i-own-this or an
 * interactive ownership attestation. v1 targets: *.lovable.app.
 */
import { Command } from 'commander';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { LlmConfig } from '@tamtunnel/unvibe-core';
import { enforceOwnershipGate, GateRefusal } from './gate.js';
import {
  runPipeline, stageCapture, stageAnalyze, stageRegenerate, stageVerify,
  stagePaths, loadSpec, UNVIBE_VERSION, type RunOptions,
} from './pipeline.js';

const program = new Command();
program
  .name('unvibe')
  .description('Rebuild a Lovable app you own into a real, self-hostable repo.')
  .version(UNVIBE_VERSION)
  .option('--i-own-this', 'attest that you own the target app (or have the owner\'s explicit permission)')
  .option('--url <url>', 'target app URL (*.lovable.app in v1)')
  .option('--work-dir <dir>', 'working directory for stages', './unvibe-out')
  .option('--cookie <cookie>', 'optional session cookie for authed routes ("name=value; ..." or JSON file)')
  .option('--max-pages <n>', 'max pages to crawl', '25')
  .option('--llm-provider <p>', 'LLM provider: openai | anthropic | mock', 'mock')
  .option('--model <m>', 'model name (openai/anthropic providers)')
  .option('--api-key <k>', 'API key (or set UNVIBE_API_KEY)')
  .option('--base-url <u>', 'base URL for OpenAI-compatible providers')
  .option('--rebuilt-url <u>', 'base URL of the rebuilt app (enables verify screenshots + live checks)')
  .option('--verify-threshold <f>', 'max allowed screenshot diff ratio per route', '0.25')
  .option('--no-leak-scan', 'disable the post-regenerate verbatim-leak scan (not recommended)')
  .option('--rea <mode>', 'REA adapter mode: auto | off', 'auto');

function llmConfig(o: Record<string, string | undefined>): LlmConfig {
  const provider = (o.llmProvider ?? 'mock') as LlmConfig['provider'];
  if (!['openai', 'anthropic', 'mock'].includes(provider)) {
    throw new GateRefusal(`Unknown --llm-provider "${provider}". Use openai, anthropic, or mock.`);
  }
  return {
    provider,
    model: o.model ?? (provider === 'anthropic' ? 'claude-sonnet-4-20250514' : provider === 'openai' ? 'gpt-4o-mini' : 'mock-spec-codegen-v1'),
    apiKey: o.apiKey,
    baseUrl: o.baseUrl,
  };
}

async function baseOptions(cmd: Command): Promise<RunOptions> {
  const o = cmd.optsWithGlobals() as Record<string, string | boolean | undefined>;
  const url = String(o.url ?? '');
  if (!url) throw new GateRefusal('Missing --url. Usage: unvibe run --url https://your-app.lovable.app --i-own-this');
  const ownership = await enforceOwnershipGate({ iOwnThis: o.iOwnThis === true, url });
  const log = (m: string) => console.log(m);
  return {
    url,
    workDir: String(o.workDir ?? './unvibe-out'),
    ownership,
    cookie: o.cookie as string | undefined,
    maxPages: Number(o.maxPages ?? 25),
    llm: llmConfig(o as Record<string, string | undefined>),
    leakScan: o.leakScan !== false,
    verifyThreshold: Number(o.verifyThreshold ?? 0.25),
    rebuiltUrl: o.rebuiltUrl as string | undefined,
    reaMode: (o.rea as string) === 'off' ? 'off' : 'auto',
    onProgress: log,
  };
}

async function main(): Promise<void> {
  program
    .command('capture')
    .description('Stage 1: deterministically crawl the live app (routes, assets, HAR, screenshots)')
    .action(async (_a, cmd) => {
      const opts = await baseOptions(cmd);
      const paths = stagePaths(opts.workDir);
      await mkdir(opts.workDir, { recursive: true });
      await stageCapture(opts, paths);
    });

  program
    .command('analyze')
    .description('Stage 2: deterministically analyze the capture into a versioned spec')
    .action(async (_a, cmd) => {
      const opts = await baseOptions(cmd);
      const paths = stagePaths(opts.workDir);
      await stageAnalyze(opts, paths);
    });

  program
    .command('regenerate')
    .description('Stage 3: LLM rebuild from the spec only (clean-room) onto deterministic scaffolds')
    .action(async (_a, cmd) => {
      const opts = await baseOptions(cmd);
      const paths = stagePaths(opts.workDir);
      const spec = await loadSpec(paths);
      await stageRegenerate(opts, paths, spec);
    });

  program
    .command('verify')
    .description('Stage 4: screenshot-diff + contract tests against the rebuilt app')
    .action(async (_a, cmd) => {
      const opts = await baseOptions(cmd);
      const paths = stagePaths(opts.workDir);
      const spec = await loadSpec(paths);
      const pass = await stageVerify(opts, paths, spec);
      if (!pass) process.exitCode = 1;
    });

  program
    .command('run')
    .description('All stages: capture → analyze → regenerate → verify')
    .action(async (_a, cmd) => {
      const opts = await baseOptions(cmd);
      const { spec, verifyPass } = await runPipeline(opts);
      const paths = stagePaths(opts.workDir);
      console.log(`\ndone: ${spec.routes.length} routes, ${spec.endpoints.length} endpoints, ${spec.entities.length} entities`);
      console.log(`output repo: ${join(opts.workDir, 'repo')}`);
      console.log(`spec: ${paths.specPath}`);
      if (!verifyPass) process.exitCode = 1;
    });

  await program.parseAsync(process.argv);
}

main().catch((e: unknown) => {
  if (e instanceof GateRefusal) {
    console.error(`unvibe: ${e.message}`);
    process.exit(2);
  }
  console.error(`unvibe: ${(e as Error).message}`);
  process.exit(1);
});
