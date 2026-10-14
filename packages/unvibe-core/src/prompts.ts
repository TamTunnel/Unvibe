/**
 * Versioned rebuild prompt pack.
 *
 * Prompts are part of the product contract: they are checked in, versioned,
 * and referenced from the spec so any rebuild is reproducible and auditable.
 * Bump PROMPT_PACK_VERSION whenever prompt text changes meaningfully.
 */
import type { LlmMessage } from './llm.js';
import type { UnvibeSpec } from './spec.js';

export const PROMPT_PACK_VERSION = '1';

/** The clean-room system instruction — attached to every regenerate call. */
export const CLEAN_ROOM_SYSTEM = `You are rebuilding a web application that the user owns, from a behavioral
specification. Hard rules:

1. Write ORIGINAL code. Reimplement observed behavior in idiomatic React +
   TypeScript. Do NOT reproduce third-party code, platform boilerplate, or
   minified bundle text — you have never seen it, and you must not invent
   "recalled" versions of it.
2. Use ONLY the information in the spec JSON below. If the spec does not
   describe something, leave it out or add a TODO comment — never hallucinate
   features, endpoints, or data fields.
3. Output ONLY the file content (no markdown fences, no explanations), unless
   the user message says otherwise.
4. Never include secrets, API keys, or credentials. Use environment variables.`;

export interface PromptInput {
  spec: UnvibeSpec;
  targetFile: string;
  kind: 'route-page' | 'api-client' | 'entity-types';
  routePath?: string;
}

/**
 * Build the regenerate prompt for one output file.
 *
 * CLEAN-ROOM GUARANTEE (structural): the prompt contains spec JSON only.
 * Bundle/minified source text is never an input to this function — the type
 * signature only accepts the validated UnvibeSpec. A runtime assertion below
 * double-checks that no prompt input accidentally carries bundle-shaped text.
 */
export function buildRegenPrompt(input: PromptInput): LlmMessage[] {
  const { spec, targetFile, kind, routePath } = input;
  const payload: Record<string, unknown> = { kind, specVersion: spec.specVersion };
  if (kind === 'route-page') {
    const route = spec.routes.find((r) => r.path === routePath) ?? spec.routes[0];
    payload.routes = [route];
    payload.navigation = spec.routes.map((r) => r.path);
  } else if (kind === 'api-client') {
    payload.endpoints = spec.endpoints;
  } else {
    payload.entities = spec.entities;
  }
  const specJson = JSON.stringify(payload, null, 2);
  assertNoBundleText(specJson);

  const task =
    kind === 'route-page'
      ? `Write the React page component for route "${routePath ?? '/'}". Render the listed components with their observed text. Use semantic HTML and Tailwind classes.`
      : kind === 'api-client'
        ? `Write a typed API client module. One exported async function per endpoint, using the apiRequest helper from "./http". Preserve HTTP methods and URL patterns exactly.`
        : `Write TypeScript interfaces for the observed data entities, one interface per entity.`;

  return [
    { role: 'system', content: CLEAN_ROOM_SYSTEM },
    {
      role: 'user',
      content:
        `TARGET-FILE: ${targetFile}\n` +
        `PROMPT-PACK: v${PROMPT_PACK_VERSION}\n\n` +
        `${task}\n\n` +
        `Behavioral spec (the ONLY source of truth):\n` +
        '```spec-json\n' + specJson + '\n```',
    },
  ];
}

/**
 * Defense-in-depth: refuse to build a prompt whose spec payload looks like
 * it contains minified bundle text (very long lines are the tell).
 * This should be unreachable — the spec schema never carries source text —
 * but it makes accidental leakage fail loudly instead of silently.
 */
export function assertNoBundleText(specJson: string): void {
  const lines = specJson.split('\n');
  for (const line of lines) {
    if (line.length > 4000) {
      throw new Error(
        'Clean-room violation: spec payload contains a >4000-char line; ' +
          'bundle text must never enter regenerate prompts.',
      );
    }
  }
}

/**
 * Scan generated files for verbatim chunks of platform bundle text.
 * Returns the list of offending { file, chunkLength } findings.
 * Used by tests and as a post-regenerate safety net.
 */
export function scanOutputForBundleLeak(
  files: Record<string, string>,
  bundleText: string,
  minChunk = 80,
): { file: string; chunkLength: number }[] {
  const findings: { file: string; chunkLength: number }[] = [];
  // Build a set of distinctive long substrings from the bundle.
  const chunks = new Set<string>();
  const clean = bundleText.replace(/\s+/g, ' ');
  for (let i = 0; i + minChunk <= clean.length; i += Math.floor(minChunk / 2)) {
    const c = clean.slice(i, i + minChunk);
    if (/[a-zA-Z0-9]{12}/.test(c)) chunks.add(c);
    if (chunks.size > 20000) break;
  }
  for (const [file, content] of Object.entries(files)) {
    const flat = content.replace(/\s+/g, ' ');
    for (const c of chunks) {
      if (flat.includes(c)) {
        findings.push({ file, chunkLength: minChunk });
        break;
      }
    }
  }
  return findings;
}
