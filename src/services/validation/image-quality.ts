import type { ValidationCheckResult } from './types';

const MIN_WIDTH = 640;
const MIN_HEIGHT = 480;
const MIN_LAPLACIAN_VARIANCE = 100;

/**
 * Image quality: resolution and blur (Laplacian variance) using sharp.
 * Returns pass if sharp is not available.
 */
export async function validateImageQuality(imageBuffer: Buffer | null): Promise<ValidationCheckResult> {
  if (!imageBuffer || imageBuffer.length === 0) {
    return { passed: true, detail: 'No image' };
  }
  try {
    const sharp = await import('sharp');
    const meta = await sharp.default(imageBuffer).metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    if (width < MIN_WIDTH || height < MIN_HEIGHT) {
      return {
        passed: false,
        detail: `Resolution too low (${width}x${height}; min ${MIN_WIDTH}x${MIN_HEIGHT})`,
      };
    }
    const gray = await sharp.default(imageBuffer).grayscale().raw().toBuffer({ resolveWithObject: true });
    const w = gray.info.width ?? width;
    const h = gray.info.height ?? height;
    const variance = computeLaplacianVariance(gray.data, w, h);
    if (variance < MIN_LAPLACIAN_VARIANCE) {
      return {
        passed: false,
        detail: `Image may be blurry (sharpness score ${variance.toFixed(0)})`,
      };
    }
    return { passed: true };
  } catch (err: any) {
    return { passed: true, detail: err?.message ?? 'Quality check skipped' };
  }
}

function computeLaplacianVariance(data: Uint8Array, w: number, h: number): number {
  if (w < 3 || h < 3) return 0;
  let sum = 0;
  let count = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const idx = y * w + x;
      const center = data[idx] ?? 0;
      const l = data[idx - 1] ?? center;
      const r = data[idx + 1] ?? center;
      const t = data[idx - w] ?? center;
      const b = data[idx + w] ?? center;
      const lap = Math.abs(4 * center - l - r - t - b);
      sum += lap;
      count += 1;
    }
  }
  const mean = count > 0 ? sum / count : 0;
  let varianceSum = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const idx = y * w + x;
      const center = data[idx] ?? 0;
      const l = data[idx - 1] ?? center;
      const r = data[idx + 1] ?? center;
      const t = data[idx - w] ?? center;
      const b = data[idx + w] ?? center;
      const lap = Math.abs(4 * center - l - r - t - b);
      varianceSum += (lap - mean) ** 2;
    }
  }
  return count > 0 ? varianceSum / count : 0;
}
