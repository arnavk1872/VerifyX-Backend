import type { ValidationCheckResult } from './types';

/** Min width/height in px; aspect ratio (width/height) must be in this range. */
const MIN_WIDTH = 200;
const MIN_HEIGHT = 120;
const MIN_ASPECT = 0.5;
const MAX_ASPECT = 3.5;

/**
 * Basic template/layout check: document image dimensions and aspect ratio.
 * If dimensions not provided (e.g. check disabled or not available), returns pass.
 */
export function validateTemplateLayout(dimensions: {
  width: number;
  height: number;
} | null): ValidationCheckResult {
  if (!dimensions || typeof dimensions.width !== 'number' || typeof dimensions.height !== 'number') {
    return { passed: true, detail: 'Dimensions not checked' };
  }
  const { width, height } = dimensions;
  if (width < MIN_WIDTH || height < MIN_HEIGHT) {
    return {
      passed: false,
      detail: `Image too small (${width}x${height}; min ${MIN_WIDTH}x${MIN_HEIGHT})`,
    };
  }
  const aspect = width / height;
  if (aspect < MIN_ASPECT || aspect > MAX_ASPECT) {
    return {
      passed: false,
      detail: `Aspect ratio ${aspect.toFixed(2)} outside expected range [${MIN_ASPECT}, ${MAX_ASPECT}]`,
    };
  }
  return { passed: true };
}
