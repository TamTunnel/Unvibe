/**
 * Product gates — enforced in code, not just documented.
 *
 * 1. Ownership: Unvibe only processes apps the user owns. The CLI requires
 *    `--i-own-this`, or an interactive attestation prompt on a TTY.
 *    Non-interactive use without the flag is refused.
 * 2. v1 scope: only `*.lovable.app` targets (UNVIBE_ALLOW_LOCALHOST=1 lifts
 *    this for local development and tests — never for real targets).
 * 3. No DRM/circumvention targets: a narrow denylist of circumvention-shaped
 *    URL patterns is refused outright.
 */
import * as readline from 'node:readline';

export interface OwnershipAttestation {
  attestedAt: string;
  method: 'flag' | 'prompt';
}

export class GateRefusal extends Error {
  readonly code = 'GATE_REFUSAL';
  constructor(message: string) {
    super(message);
    this.name = 'GateRefusal';
  }
}

/** Narrow denylist: URL patterns shaped like DRM/circumvention tooling. */
const CIRCUMVENTION_PATTERNS: RegExp[] = [
  /drm[-_ ]?crack/i,
  /drm[-_ ]?removal/i,
  /keygen/i,
  /cheat[-_ ]?engine/i,
  /paywall[-_ ]?bypass/i,
  /widevine[-_ ]?(dump|decrypt)/i,
];

export function checkCircumventionTarget(url: string): void {
  const hit = CIRCUMVENTION_PATTERNS.find((re) => re.test(url));
  if (hit) {
    throw new GateRefusal(
      `Refused: target looks like a DRM/circumvention tool (${hit}). ` +
        'Unvibe only rebuilds apps you own — it is not a circumvention tool.',
    );
  }
}

/** v1 scope: Lovable only. Localhost allowed only via explicit dev opt-in. */
export function checkTargetScope(url: string): void {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    throw new GateRefusal(`Refused: "${url}" is not a valid URL.`);
  }
  const allowLocal = process.env.UNVIBE_ALLOW_LOCALHOST === '1';
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (isLocal && allowLocal) return;
  if (isLocal) {
    throw new GateRefusal(
      'Refused: v1 targets must be *.lovable.app. ' +
        'Localhost is only allowed with UNVIBE_ALLOW_LOCALHOST=1 (development/tests).',
    );
  }
  if (!host.endsWith('.lovable.app')) {
    throw new GateRefusal(
      `Refused: "${host}" is not a Lovable app. v1 supports *.lovable.app targets only.`,
    );
  }
}

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
 * Enforce the ownership gate. Returns the attestation record for the spec,
 * or throws GateRefusal.
 */
export async function enforceOwnershipGate(opts: GateOptions): Promise<OwnershipAttestation> {
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
