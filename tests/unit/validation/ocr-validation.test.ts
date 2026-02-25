import { describe, it, expect } from 'vitest';
import { validateOcrFields } from '../../../src/services/validation/ocr-validation';

describe('OCR Validation', () => {
  it('fails when name is missing', () => {
    const result = validateOcrFields({
      idNumber: 'A1234567',
      extractedFields: {},
    });
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('name');
  });

  it('fails when ID number is missing', () => {
    const result = validateOcrFields({
      fullName: 'John Doe',
      extractedFields: {},
    });
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('ID number');
  });

  it('fails when both are missing', () => {
    const result = validateOcrFields({ extractedFields: {} });
    expect(result.passed).toBe(false);
  });

  it('fails when name is empty string', () => {
    const result = validateOcrFields({
      fullName: '   ',
      idNumber: 'A123',
      extractedFields: {},
    });
    expect(result.passed).toBe(false);
  });

  it('passes when name and ID number present', () => {
    const result = validateOcrFields({
      fullName: 'Jane Doe',
      idNumber: 'P1234567',
      extractedFields: {},
    });
    expect(result.passed).toBe(true);
  });
});
