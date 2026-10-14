/**
 * Product gates — the security boundary, enforced in code, not just documented.
 *
 * This module lives in @tamtunnel/unvibe-core (not the CLI) deliberately:
 * the CLI is the UX layer, but the gates must hold for ANY caller of the
 * pipeline (library use, tests, future surfaces). `stageCapture` and
 * `runPipeline` call these; `captureSite` additionally refuses non-HTTP(S)
 * schemes outright.
 *
 * 1. Ownership: Unvibe only processes apps the user owns. The pipeline
 *    requires a validated OwnershipAttestation (CLI obtains it via
 *    --i-own-this or the interactive prompt).
 * 2. v1 scope: only `*.lovable.app` targets (UNVIBE_ALLOW_LOCALHOST=1 lifts
 *    this for local development and tests — never for real targets).
 * 3. No circumvention-shaped targets: a denylist of circumvention-tool-shaped
 *    URL patterns is refused outright. HONEST SCOPE: this is a URL-shape
 *    denylist only. It CANNOT detect a DRM-protected app behind an
 *    ordinary-looking URL (e.g. `netflix-clone-paywall.lovable.app` passes
 *    and always will). Ownership attestation is the real control; this
 *    denylist is a tripwire for the obvious cases.
 */
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

/**
 * Normalize a URL for denylist matching: repeatedly percent-decode (defeats
 * drm%2dcrack / double-encoded variants), lowercase, and strip separators.
 */
export function normalizeForDenylist(url: string): string {
  let s = url;
  for (let i = 0; i < 3; i++) {
    try {
      const d = decodeURIComponent(s);
      if (d === s) break;
      s = d;
    } catch {
      break; // malformed % sequences: match against what we have
    }
  }
  return s.toLowerCase().replace(/[-_.\s]+/g, '');
}

/**
 * Denylist: URL shapes characteristic of DRM/circumvention tooling.
 * Matched against the NORMALIZED url (see above). This refuses
 * circumvention-tool-shaped targets; it does not — and cannot — detect
 * DRM-protected content served from an ordinary-looking app URL.
 */
const CIRCUMVENTION_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /drmcrack/, label: 'drm-crack' },
  { re: /drmremoval/, label: 'drm-removal' },
  { re: /keygen/, label: 'keygen' },
  { re: /cheatengine/, label: 'cheat-engine' },
  { re: /paywallbypass/, label: 'paywall-bypass' },
  { re: /widevinedump/, label: 'widevine-dump' },
  { re: /widevinedecrypt/, label: 'widevine-decrypt' },
];

export function checkCircumventionTarget(url: string): void {
  const normalized = normalizeForDenylist(url);
  const hit = CIRCUMVENTION_PATTERNS.find((p) => p.re.test(normalized));
  if (hit) {
    throw new GateRefusal(
      `Refused: target looks like a DRM/circumvention tool (${hit.label}). ` +
        'Unvibe only rebuilds apps you own — it is not a circumvention tool. ' +
        'Note: this is a URL-shape denylist; it cannot detect DRM-protected ' +
        'content behind ordinary URLs.',
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

/**
 * Validate an OwnershipAttestation record. The pipeline refuses to run
 * without one — attestation is produced by the CLI's --i-own-this flag or
 * the interactive YES prompt, and verified here, at the security boundary.
 */
export function assertValidAttestation(att: unknown): asserts att is OwnershipAttestation {
  if (
    !att || typeof att !== 'object' ||
    typeof (att as OwnershipAttestation).attestedAt !== 'string' ||
    !['flag', 'prompt'].includes((att as OwnershipAttestation).method)
  ) {
    throw new GateRefusal(
      'Refused: a validated ownership attestation is required. ' +
        'Attest via --i-own-this (or the interactive prompt) before running the pipeline. ' +
        'Unvibe only processes apps you own.',
    );
  }
}

/**
 * Strip userinfo (username:password) from a URL. Credentials in --url must
 * never be persisted: the stripped URL is what enters the spec, scaffold,
 * and README. The original is kept in memory only, for the fetch itself.
 */
export function stripUrlCredentials(url: string): string {
  try {
    const u = new URL(url);
    u.username = '';
    u.password = '';
    return u.toString();
  } catch {
    return url;
  }
}

/** Normalize a URL for equality comparison (case, default ports, trailing slash, credentials). */
export function normalizeUrlForCompare(url: string): string {
  const stripped = stripUrlCredentials(url);
  try {
    const u = new URL(stripped);
    u.hostname = u.hostname.toLowerCase();
    if ((u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80')) {
      u.port = '';
    }
    return u.toString().replace(/\/$/, '');
  } catch {
    return stripped;
  }
}

/**
 * Spec integrity across stages: `regenerate`/`verify` must run against the
 * spec produced from THIS --url, not a hand-swapped one. Refuses on mismatch.
 */
export function checkUrlMatchesSpec(cliUrl: string, specUrl: string): void {
  if (normalizeUrlForCompare(cliUrl) !== normalizeUrlForCompare(specUrl)) {
    throw new GateRefusal(
      `Refused: --url ${normalizeUrlForCompare(cliUrl)} does not match the spec's ` +
        `source.url ${normalizeUrlForCompare(specUrl)}. Re-run analyze for this target, ` +
        'or pass the URL the spec was captured from.',
    );
  }
}
