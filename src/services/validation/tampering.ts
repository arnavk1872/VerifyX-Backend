import type { ValidationCheckResult } from './types';

/**
 * Tampering detection (ELA-style and blur) using sharp.
 * Returns pass if sharp is not available or image cannot be processed.
 */
export async function validateTampering(imageBuffer: Buffer | null): Promise<ValidationCheckResult> {
  if (!imageBuffer || imageBuffer.length === 0) {
    return { passed: true, detail: 'No image' };
  }
  try {
    const sharp = await import('sharp');
    const meta = await sharp.default(imageBuffer).metadata();
    const { width = 0, height = 0 } = meta;
    if (width < 50 || height < 50) {
      return { passed: false, detail: 'Image too small for analysis' };
    }
    const reencoded = await sharp
      .default(imageBuffer)
      .jpeg({ quality: 90 })
      .toBuffer();
    const diff = Math.abs(imageBuffer.length - reencoded.length);
    const ratio = imageBuffer.length > 0 ? diff / imageBuffer.length : 0;
    if (ratio > 0.5) {
      return {
        passed: false,
        detail: `High re-encoding difference (ELA-style ratio ${(ratio * 100).toFixed(1)}%)`,
      };
    }
    const gray = await sharp.default(imageBuffer).grayscale().raw().toBuffer({ resolveWithObject: true });
    const laplacianVariance = computeLaplacianVariance(gray.data, gray.info.width ?? width, gray.info.height ?? height);
    if (laplacianVariance < 50) {
      return { passed: false, detail: `Low sharpness (variance ${laplacianVariance.toFixed(0)})` };
    }
    return { passed: true };
  } catch (err: any) {
    return { passed: true, detail: err?.message ?? 'Tampering check skipped' };
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
