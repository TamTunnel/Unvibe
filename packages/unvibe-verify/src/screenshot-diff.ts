/**
 * Screenshot-diff fidelity gate.
 *
 * For each spec route: screenshot the rebuilt app at that route, compare
 * against the original capture screenshot with pixelmatch, and report the
 * fraction of differing pixels. The gate passes when every route is under
 * the threshold.
 *
 * Honest scope: this checks that the same routes render *roughly* the same
 * content. Pixel-perfect UI is explicitly out of scope — the default
 * threshold is generous on purpose.
 */
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { chromium } from 'playwright';
import type { UnvibeSpec } from '@tamtunnel/unvibe-core';

export interface RouteDiff {
  path: string;
  original: string;
  rebuilt: string;
  diffPath?: string;
  diffRatio: number; // 0 = identical, 1 = entirely different
  pass: boolean;
  note?: string;
}

export interface ScreenshotDiffOptions {
  spec: UnvibeSpec;
  /** Directory holding the original capture (screenshots/…). */
  captureDir: string;
  /** Base URL of the rebuilt app (dev server or preview). */
  rebuiltBaseUrl: string;
  /** Where to write rebuilt screenshots + diff images. */
  outDir: string;
  /** Max allowed diff ratio per route. Default 0.25 (generous by design). */
  threshold?: number;
  viewport?: { width: number; height: number };
  onProgress?: (msg: string) => void;
}

export interface ScreenshotDiffResult {
  routes: RouteDiff[];
  pass: boolean;
  threshold: number;
}

async function loadPng(path: string): Promise<PNG> {
  const buf = await readFile(path);
  return PNG.sync.read(buf);
}

export function comparePng(a: PNG, b: PNG): number {
  const width = Math.min(a.width, b.width);
  const height = Math.min(a.height, b.height);
  const da = new PNG({ width, height });
  const db = new PNG({ width, height });
  PNG.bitblt(a, da, 0, 0, width, height, 0, 0);
  PNG.bitblt(b, db, 0, 0, width, height, 0, 0);
  const diff = new PNG({ width, height });
  const changed = pixelmatch(da.data, db.data, diff.data, width, height, { threshold: 0.1 });
  return changed / (width * height);
}

export function diffToPng(a: PNG, b: PNG): Buffer {
  const width = Math.min(a.width, b.width);
  const height = Math.min(a.height, b.height);
  const da = new PNG({ width, height });
  const db = new PNG({ width, height });
  PNG.bitblt(a, da, 0, 0, width, height, 0, 0);
  PNG.bitblt(b, db, 0, 0, width, height, 0, 0);
  const diff = new PNG({ width, height });
  pixelmatch(da.data, db.data, diff.data, width, height, { threshold: 0.1 });
  return PNG.sync.write(diff);
}

export async function screenshotDiff(opts: ScreenshotDiffOptions): Promise<ScreenshotDiffResult> {
  const {
    spec, captureDir, rebuiltBaseUrl, outDir,
    threshold = 0.25,
    viewport = { width: 1280, height: 800 },
    onProgress,
  } = opts;
  const log = onProgress ?? (() => {});
  await mkdir(outDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const routes: RouteDiff[] = [];
  try {
    const context = await browser.newContext({ viewport });
    for (const route of spec.routes) {
      const original = join(captureDir, route.screenshot);
      const rebuiltShot = join(outDir, `rebuilt-${basename(route.screenshot)}`);
      const diffPath = join(outDir, `diff-${basename(route.screenshot)}`);
      const page = await context.newPage();
      try {
        await page.goto(rebuiltBaseUrl.replace(/\/$/, '') + route.path, {
          waitUntil: 'networkidle', timeout: 30_000,
        });
      } catch (e) {
        await page.close().catch(() => {});
        routes.push({
          path: route.path, original, rebuilt: rebuiltShot,
          diffRatio: 1, pass: false,
          note: `could not load rebuilt route: ${(e as Error).message.split('\n')[0]}`,
        });
        continue;
      }
      await page.screenshot({ path: rebuiltShot, fullPage: false });
      await page.close().catch(() => {});
      try {
        const [a, b] = await Promise.all([loadPng(original), loadPng(rebuiltShot)]);
        const ratio = comparePng(a, b);
        await writeFile(diffPath, diffToPng(a, b));
        const pass = ratio <= threshold;
        log(`verify: ${route.path} diff ${(ratio * 100).toFixed(1)}% ${pass ? 'PASS' : 'FAIL'}`);
        routes.push({ path: route.path, original, rebuilt: rebuiltShot, diffPath, diffRatio: ratio, pass });
      } catch (e) {
        routes.push({
          path: route.path, original, rebuilt: rebuiltShot,
          diffRatio: 1, pass: false,
          note: `could not compare screenshots: ${(e as Error).message.split('\n')[0]}`,
        });
      }
    }
    await context.close();
  } finally {
    await browser.close();
  }
  return { routes, pass: routes.every((r) => r.pass), threshold };
}
