import { describe, it, expect } from 'vitest';
import { PNG } from 'pngjs';
import { comparePng, diffToPng } from '../src/screenshot-diff.js';

function solid(w: number, h: number, r: number, g: number, b: number): PNG {
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      png.data[i] = r; png.data[i + 1] = g; png.data[i + 2] = b; png.data[i + 3] = 255;
    }
  }
  return png;
}

describe('comparePng', () => {
  it('returns 0 for identical images', () => {
    expect(comparePng(solid(64, 64, 10, 20, 30), solid(64, 64, 10, 20, 30))).toBe(0);
  });

  it('returns ~1 for fully different images', () => {
    const ratio = comparePng(solid(64, 64, 0, 0, 0), solid(64, 64, 255, 255, 255));
    expect(ratio).toBeGreaterThan(0.99);
  });

  it('returns a partial ratio for partially different images', () => {
    const a = solid(100, 100, 200, 200, 200);
    const b = solid(100, 100, 200, 200, 200);
    // Paint the top-left quadrant black.
    for (let y = 0; y < 50; y++) {
      for (let x = 0; x < 50; x++) {
        const i = (y * 100 + x) * 4;
        b.data[i] = 0; b.data[i + 1] = 0; b.data[i + 2] = 0;
      }
    }
    const ratio = comparePng(a, b);
    expect(ratio).toBeGreaterThan(0.2);
    expect(ratio).toBeLessThan(0.3);
  });

  it('diffToPng produces a viewable diff image', () => {
    const buf = diffToPng(solid(32, 32, 0, 0, 0), solid(32, 32, 255, 0, 0));
    const back = PNG.sync.read(buf);
    expect(back.width).toBe(32);
  });
});
