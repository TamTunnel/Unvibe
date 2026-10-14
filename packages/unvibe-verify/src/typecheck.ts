/**
 * Compile gate for the regenerated output repo (M6).
 *
 * String greps pass on non-compiling output, so stageVerify typechecks the
 * generated sources with the TypeScript compiler API and fails the gate on
 * real compile errors.
 *
 * Honest scope: the output repo's node_modules are NOT installed at verify
 * time, so "cannot find module 'react'"-style diagnostics for bare
 * third-party specifiers are recorded as warnings, not failures — the repo's
 * own `npm install && npm run build` remains the full check. Syntax errors,
 * type errors within project files, and missing local modules FAIL.
 */
import { readdir } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join, extname, relative, sep } from 'node:path';
import ts from 'typescript';

export interface TypecheckResult {
  errors: string[];
  warnings: string[];
  pass: boolean;
}

/** Asset imports are resolved by the bundler (vite), not tsc — never gate failures. */
const ASSET_EXTS = new Set(['.css', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.woff', '.woff2', '.ttf', '.mp4', '.webm', '.ico', '.json']);

/**
 * Virtual declaration so `import.meta.env` (used by the scaffold's http.ts)
 * typechecks without vite/client installed.
 */
const VIRTUAL_DTS = '/__unvibe_virtual__/env.d.ts';
const VIRTUAL_DTS_CONTENT = `interface ImportMeta { env: Record<string, string | undefined>; }\n`;

async function collectSources(dir: string, out: string[]): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === 'dist') continue;
    const abs = join(dir, e.name);
    if (e.isDirectory()) await collectSources(abs, out);
    else if (['.ts', '.tsx'].includes(extname(e.name))) out.push(abs);
  }
}

export async function typecheckOutputRepo(repoDir: string): Promise<TypecheckResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const files: string[] = [];
  await collectSources(join(repoDir, 'src'), files);
  if (files.length === 0) {
    return { errors: ['no TypeScript sources found under src/'], warnings: [], pass: false };
  }
  const options: ts.CompilerOptions = {
    noEmit: true,
    strict: false,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    types: [], // don't require @types packages that aren't installed
  };
  const host = ts.createCompilerHost(options);
  const origGetSourceFile = host.getSourceFile.bind(host);
  const origFileExists = host.fileExists.bind(host);
  host.getSourceFile = (fileName, languageVersion, ...rest) => {
    if (fileName === VIRTUAL_DTS) {
      return ts.createSourceFile(fileName, VIRTUAL_DTS_CONTENT, languageVersion, true);
    }
    return origGetSourceFile(fileName, languageVersion, ...rest);
  };
  host.fileExists = (fileName) => fileName === VIRTUAL_DTS || origFileExists(fileName);
  const program = ts.createProgram([...files, VIRTUAL_DTS], options, host);
  const diagnostics = [
    ...program.getSyntacticDiagnostics(),
    ...program.getSemanticDiagnostics(),
    ...program.getGlobalDiagnostics(),
  ];
  for (const d of diagnostics) {
    const msg = ts.flattenDiagnosticMessageText(d.messageText, ' ');
    const file = d.file ? relative(repoDir, d.file.fileName).split(sep).join('/') : '';
    const loc = d.file && typeof d.start === 'number'
      ? `${file}:${d.file.getLineAndCharacterOfPosition(d.start).line + 1}`
      : file || '(global)';
    const entry = `TS${d.code} ${loc}: ${msg}`;
    const missingModule = /'([^']+)'/.exec(msg)?.[1] ?? '';
    // Any diagnostic that names a BARE (non-relative) module specifier is
    // about a third-party dep that isn't installed at verify time → warning.
    // Relative/absolute misses are real errors in project files.
    const namesBareModule = missingModule !== '' && !/^[./]/.test(missingModule);
    // Asset imports (./index.css) are resolved by the bundler, not tsc.
    const isAssetImport = missingModule !== '' && ASSET_EXTS.has(extname(missingModule));
    const isDepWarning = (namesBareModule || isAssetImport) && /module/i.test(msg);
    if (isDepWarning) {
      warnings.push(entry + ' (third-party dep not installed; full check is `npm install && npm run build`)');
    } else {
      errors.push(entry);
    }
  }
  return { errors, warnings, pass: errors.length === 0 };
}
