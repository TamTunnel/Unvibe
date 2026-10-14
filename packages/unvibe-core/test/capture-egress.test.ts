import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  captureSite, assertEgressAllowed, EgressBlockedError,
} from '../src/capture.js';

/**
 * Judge #1 / B2 / m10 regression tests: the crawler must validate EVERY hop.
 * - file:// URLs are refused outright (B2).
 * - A 302 to an internal address is refused and the internal server is never hit (Judge #1).
 * - Cross-origin hops and private/metadata IP literals are blocked (unit).
 * - A client-side cross-origin redirect doesn't get captured as the target's route (m10).
 */
describe('captureSite scheme refusal (B2)', () => {
  it('refuses file:// URLs outright', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'unvibe-scheme-'));
    await expect(captureSite({ url: 'file:///etc/passwd', outDir, onProgress: () => {} }))
      .rejects.toThrow(/non-HTTP\(S\)/);
  });
});

describe('assertEgressAllowed (unit)', () => {
  it('blocks cross-origin hops', async () => {
    await expect(assertEgressAllowed('http://127.0.0.1:18923/steal', 'http://localhost:3000', 'localhost'))
      .rejects.toThrow(EgressBlockedError);
  });
  it('blocks metadata/private IP literals even when the origin matches', async () => {
    // Same origin string, but the hop targets a different host that is an IP literal.
    await expect(assertEgressAllowed('http://169.254.169.254/', 'http://169.254.169.254', 'app.lovable.app'))
      .rejects.toThrow(/private\/metadata IP/);
    await expect(assertEgressAllowed('http://10.0.0.5/', 'http://10.0.0.5', 'app.lovable.app'))
      .rejects.toThrow(EgressBlockedError);
  });
  it('allows the explicitly targeted initial host', async () => {
    await expect(assertEgressAllowed('http://localhost:3000/', 'http://localhost:3000', 'localhost'))
      .resolves.toBeUndefined();
  });
  it('blocks non-HTTP(S) schemes', async () => {
    await expect(assertEgressAllowed('file:///etc/passwd', 'null', 'x'))
      .rejects.toThrow(EgressBlockedError);
  });
});

describe('redirect-chain SSRF (Judge #1)', () => {
  let victim: Server;   // the "internal" server that must never be hit
  let redirector: Server; // 302s to the victim
  let victimPort = 0;
  let redirectorPort = 0;
  let victimHits = 0;

  beforeAll(async () => {
    victim = createServer((_req, res) => {
      victimHits++;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('stolen');
    });
    await new Promise<void>((r) => victim.listen(0, '127.0.0.1', r));
    victimPort = (victim.address() as { port: number }).port;

    redirector = createServer((req, res) => {
      if (req.url === '/') {
        res.writeHead(302, { location: `http://127.0.0.1:${victimPort}/steal` });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><head><title>t</title></head><body>ok</body></html>');
    });
    await new Promise<void>((r) => redirector.listen(0, '127.0.0.1', r));
    redirectorPort = (redirector.address() as { port: number }).port;
  });

  afterAll(async () => {
    victim.close();
    redirector.close();
  });

  it('refuses a 302 to an internal address and never hits the internal server', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'unvibe-redirect-'));
    victimHits = 0;
    await expect(
      captureSite({ url: `http://localhost:${redirectorPort}/`, outDir, maxPages: 1, onProgress: () => {} }),
    ).rejects.toThrow(EgressBlockedError);
    expect(victimHits).toBe(0);
  });
});

describe('client-side cross-origin redirect is not captured (m10)', () => {
  let victim: Server;
  let lander: Server;
  let victimPort = 0;
  let landerPort = 0;
  let victimHits = 0;

  beforeAll(async () => {
    victim = createServer((_req, res) => {
      victimHits++;
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><head><title>evil</title></head><body>evil</body></html>');
    });
    await new Promise<void>((r) => victim.listen(0, '127.0.0.1', r));
    victimPort = (victim.address() as { port: number }).port;

    lander = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(
        `<html><head><title>lander</title>` +
          `<meta http-equiv="refresh" content="0;url=http://127.0.0.1:${victimPort}/">` +
          '</head><body>leaving</body></html>',
      );
    });
    await new Promise<void>((r) => lander.listen(0, '127.0.0.1', r));
    landerPort = (lander.address() as { port: number }).port;
  });

  afterAll(async () => {
    victim.close();
    lander.close();
  });

  it('skips the route instead of capturing cross-origin content', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'unvibe-metarefresh-'));
    victimHits = 0;
    const result = await captureSite({
      url: `http://localhost:${landerPort}/`, outDir, maxPages: 1, onProgress: () => {},
    });
    // The lander page itself may be recorded (it loaded same-origin); the
    // victim must never be fetched and no route may claim its content.
    expect(victimHits).toBe(0);
    for (const r of result.routes) {
      expect(r.title).not.toMatch(/evil/);
    }
  });
});

describe('capture resilience (M7 / m10)', () => {
  it('routeKey strips tracking params so they do not multiply routes (m10)', async () => {
    const { routeKey } = await import('../src/capture.js');
    expect(routeKey(new URL('http://x.test/about?utm_source=google&gclid=abc'))).toBe('/about');
    expect(routeKey(new URL('http://x.test/about?fbclid=1&utm_medium=cpc'))).toBe('/about');
    expect(routeKey(new URL('http://x.test/search?q=hello&utm_source=x'))).toBe('/search?q=hello');
  });

  it('records the route even when a hanging request defeats network idle (M7)', async () => {
    const server = createServer((req, res) => {
      if (req.url === '/hang') {
        // Never respond — with waitUntil: networkidle this route would be
        // skipped after the timeout; domcontentloaded must still record it.
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><head><title>slow</title></head><body><script>fetch("/hang").catch(()=>{})</script>hi</body></html>');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    try {
      const outDir = await mkdtemp(join(tmpdir(), 'unvibe-m7-'));
      const result = await captureSite({
        url: `http://localhost:${port}/`, outDir, maxPages: 1, timeoutMs: 4000, onProgress: () => {},
      });
      expect(result.routes.map((r) => r.path)).toEqual(['/']);
    } finally {
      server.closeAllConnections?.();
      server.close();
    }
  }, 30000);
});
