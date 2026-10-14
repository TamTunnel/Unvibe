/**
 * CLI-side ownership UX: --i-own-this flag or the interactive YES prompt.
 *
 * The security boundary itself (scope checks, circumvention denylist,
 * attestation validation) lives in @tamtunnel/unvibe-core/src/gate.ts so it
 * holds for every pipeline caller, not just this CLI. This module is the UX
 * layer that OBTAINS the attestation; pipeline.ts ENFORCES it.
 */
import * as readline from 'node:readline';
import {
  checkCircumventionTarget,
  checkTargetScope,
  GateRefusal,
} from '@tamtunnel/unvibe-core';

export {
  checkCircumventionTarget,
  checkTargetScope,
  normalizeForDenylist,
  stripUrlCredentials,
  normalizeUrlForCompare,
  checkUrlMatchesSpec,
  assertValidAttestation,
  GateRefusal,
} from '@tamtunnel/unvibe-core';
export type { OwnershipAttestation } from '@tamtunnel/unvibe-core';

export interface GateOptions {
  /** --i-own-this was passed */
  iOwnThis: boolean;
  /** Target URL (scope + circumvention checks) */
  url: string;
  /** Override TTY detection (tests) */
  tty?: boolean;
  /** Prompt implementation (tests inject a fake) */
  promptFn?: () => Promise<string>;
}

function defaultPrompt(): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(
      'Ownership attestation: do you own this app, or have the owner\'s explicit permission to rebuild it?\n' +
        'Type YES to attest (anything else aborts): ',
      (answer) => {
        rl.close();
        resolve(answer);
      },
    );
  });
}

/**
 * Obtain the ownership attestation: --i-own-this, or the interactive YES
 * prompt on a TTY. Scope + circumvention checks run first so obviously
 * out-of-scope targets are refused before any attestation is requested.
 */
export async function enforceOwnershipGate(
  opts: GateOptions,
): Promise<import('@tamtunnel/unvibe-core').OwnershipAttestation> {
  checkCircumventionTarget(opts.url);
  checkTargetScope(opts.url);

  if (opts.iOwnThis) {
    return { attestedAt: new Date().toISOString(), method: 'flag' };
  }
  const isTty = opts.tty ?? process.stdin.isTTY === true;
  if (!isTty) {
    throw new GateRefusal(
      'Ownership attestation required: pass --i-own-this to attest that you own this app, ' +
        'or run interactively to complete the attestation prompt. Unvibe only processes apps you own.',
    );
  }
  const answer = (await (opts.promptFn ?? defaultPrompt)()).trim().toLowerCase();
  if (answer !== 'yes') {
    throw new GateRefusal('Ownership not attested — aborting. Unvibe only processes apps you own.');
  }
  return { attestedAt: new Date().toISOString(), method: 'prompt' };
}
