/**
 * Spec integrity between stages (Judge #6).
 *
 * A hand-edited unvibe-spec.json (gaps deleted, source.url forged, no
 * capture dir) must not sail through loadSpec() into a full repo write.
 * At analyze time we record a sha256 of the canonical spec JSON; loadSpec()
 * re-verifies it and refuses on mismatch, missing integrity data, or
 * tampering.
 */
import { createHash } from 'node:crypto';

/** Deterministic JSON: object keys sorted recursively, no whitespace. */
export function canonicalStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    const keys = Object.keys(rec).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(rec[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** sha256 hex of the canonical spec JSON. */
export function specIntegrityHash(spec: unknown): string {
  return createHash('sha256').update(canonicalStringify(spec), 'utf8').digest('hex');
}

export interface SpecIntegrityRecord {
  sha256: string;
  specVersion: string;
  writtenAt: string; // ISO-8601
}

/** Build the integrity record to persist next to the spec. */
export function buildIntegrityRecord(spec: { specVersion: string }): SpecIntegrityRecord {
  return {
    sha256: specIntegrityHash(spec),
    specVersion: spec.specVersion,
    writtenAt: new Date().toISOString(),
  };
}

/** Verify a parsed spec against its integrity record. Returns a human-readable issue, or null when intact. */
export function verifyIntegrity(spec: unknown, record: unknown): string | null {
  if (!record || typeof record !== 'object') {
    return 'missing spec.integrity.json — the spec was not written by `unvibe analyze` (or the integrity file was deleted). Re-run analyze.';
  }
  const rec = record as Partial<SpecIntegrityRecord>;
  if (typeof rec.sha256 !== 'string' || typeof rec.specVersion !== 'string') {
    return 'spec.integrity.json is malformed — refusing to trust this spec. Re-run analyze.';
  }
  const actual = specIntegrityHash(spec);
  if (actual !== rec.sha256) {
    return (
      `spec integrity mismatch: unvibe-spec.json does not match spec.integrity.json ` +
        `(expected sha256 ${rec.sha256.slice(0, 16)}…, got ${actual.slice(0, 16)}…). ` +
        'The spec was modified after analyze — refusing to regenerate from a tampered spec. Re-run analyze.'
    );
  }
  return null;
}
