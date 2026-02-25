import { describe, it, expect } from 'vitest';
import { validateTemplateLayout } from '../../../src/services/validation/template-matching';

describe('Template Matching', () => {
  it('passes when dimensions not provided', () => {
    expect(validateTemplateLayout(null)).toEqual({ passed: true, detail: 'Dimensions not checked' });
  });

  it('fails when image too small', () => {
    const result = validateTemplateLayout({ width: 100, height: 80 });
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('small');
  });

  it('fails when aspect ratio too narrow', () => {
    const result = validateTemplateLayout({ width: 250, height: 800 });
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('Aspect');
  });

  it('fails when aspect ratio too wide', () => {
    const result = validateTemplateLayout({ width: 1200, height: 300 });
    expect(result.passed).toBe(false);
  });

  it('passes for valid dimensions', () => {
    expect(validateTemplateLayout({ width: 800, height: 600 })).toEqual({ passed: true });
    expect(validateTemplateLayout({ width: 400, height: 300 })).toEqual({ passed: true });
  });
});
