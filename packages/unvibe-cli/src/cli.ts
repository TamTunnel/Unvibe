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
import { enforceOwnershipGate, GateRefusal, stripUrlCredentials, checkUrlMatchesSpec } from './gate.js';
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
  .option('--cookie <cookie>', 'optional session cookie for authed routes ("name=value; ..." or JSON file; or set UNVIBE_COOKIE)')
  .option('--max-pages <n>', 'max pages to crawl', '25')
  .option('--llm-provider <p>', 'LLM provider: openai | anthropic | mock', 'mock')
  .option('--model <m>', 'model name (openai/anthropic providers)')
  .option('--api-key <k>', 'API key (or set UNVIBE_API_KEY; env var preferred — CLI flags are visible in ps/history)')
  .option('--base-url <u>', 'base URL for OpenAI-compatible providers')
  .option('--rebuilt-url <u>', 'base URL of the rebuilt app (enables verify screenshots + live checks)')
  .option('--verify-threshold <f>', 'max allowed screenshot diff ratio per route', '0.25')
  .option('--no-leak-scan', 'disable the post-regenerate verbatim-leak scan (not recommended)')
  .option('--force', 'proceed despite verbatim-leak findings (downgrades the abort to a warning; not recommended)')
  .option('--allow-empty', 'accept an endpoint-free / entity-free rebuild in contract tests')
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
  // Judge #8: --i-own-this is a valueless attestation flag. Commander parses
  // `--i-own-this 0` as flag=true plus a stray "0" operand — that must never
  // silently attest. ( `--i-own-this=false` already errors in commander.)
  // No subcommand takes positional operands, so ANY operand is a usage error.
  const operands = (cmd as Command).args as string[];
  if (operands.length > 0) {
    throw new GateRefusal(
      `Unexpected argument(s): ${operands.map((a) => `"${a}"`).join(', ')}. ` +
        'unvibe commands take no positional arguments — did you attach a value to a flag? ' +
        '--i-own-this takes no value: attest with the bare flag or the interactive YES prompt.',
    );
  }
  const url = String(o.url ?? '');
  if (!url) throw new GateRefusal('Missing --url. Usage: unvibe run --url https://your-app.lovable.app --i-own-this');
  const ownership = await enforceOwnershipGate({ iOwnThis: o.iOwnThis === true, url });
  const log = (m: string) => console.log(m);
  // Judge #3b: strip userinfo before the URL enters the spec/scaffold/README.
  // The original (with credentials) is kept in memory only, for the fetch.
  const cleanUrl = stripUrlCredentials(url);
  if (cleanUrl !== url) {
    log('unvibe: stripped credentials from --url (kept in memory for the fetch only; never persisted)');
  }
  return {
    url: cleanUrl,
    fetchUrl: url,
    workDir: String(o.workDir ?? './unvibe-out'),
    ownership,
    cookie: (o.cookie as string | undefined) ?? process.env.UNVIBE_COOKIE,
    maxPages: Number(o.maxPages ?? 25),
    llm: llmConfig(o as Record<string, string | undefined>),
    leakScan: o.leakScan !== false,
    force: o.force === true,
    allowEmpty: o.allowEmpty === true,
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
      // Judge #6: the staged --url must match the spec's source.url.
      checkUrlMatchesSpec(opts.url, spec.source.url);
      await stageRegenerate(opts, paths, spec);
    });

  program
    .command('verify')
    .description('Stage 4: screenshot-diff + contract tests against the rebuilt app')
    .action(async (_a, cmd) => {
      const opts = await baseOptions(cmd);
      const paths = stagePaths(opts.workDir);
      const spec = await loadSpec(paths);
      // Judge #6: the staged --url must match the spec's source.url.
      checkUrlMatchesSpec(opts.url, spec.source.url);
      const { pass } = await stageVerify(opts, paths, spec);
      if (!pass) process.exitCode = 1;
    });

  program
    .command('run')
    .description('All stages: capture → analyze → regenerate → verify')
    .action(async (_a, cmd) => {
      const opts = await baseOptions(cmd);
      const { spec, verifyPass, verifyLiveSkipped } = await runPipeline(opts);
      const paths = stagePaths(opts.workDir);
      if (!verifyPass) {
        // Judge #5: on verify failure the failure summary comes FIRST —
        // no success summary for an unverified repo.
        console.log('\nVERIFY FAILED — output repo is not shippable (see VERIFY-FAILED.md in the repo).');
        console.log(`spec: ${paths.specPath}`);
        console.log(`report: ${join(opts.workDir, 'verify', 'report.md')}`);
        process.exitCode = 1;
        return;
      }
      console.log(`\ndone: ${spec.routes.length} routes, ${spec.endpoints.length} endpoints, ${spec.entities.length} entities`);
      console.log(`output repo: ${join(opts.workDir, 'repo')}`);
      console.log(`spec: ${paths.specPath}`);
      if (verifyLiveSkipped) {
        console.log('verify: static contract + compile gates PASS; live checks SKIPPED (no --rebuilt-url)');
      }
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
