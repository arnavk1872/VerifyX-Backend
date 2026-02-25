import { describe, it, expect } from 'vitest';
import { validateFieldConsistency } from '../../../src/services/validation/field-consistency';

describe('Field Consistency', () => {
  it('passes when no dates', () => {
    expect(validateFieldConsistency({ extractedFields: {} })).toEqual({ passed: true });
  });

  it('fails when DOB is in the future', () => {
    const futureYear = new Date().getFullYear() + 1;
    const result = validateFieldConsistency({
      dob: `${futureYear}-06-15`,
      extractedFields: {},
    });
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('future');
  });

  it('passes when DOB is in the past', () => {
    const result = validateFieldConsistency({
      dob: '1990-01-01',
      extractedFields: {},
    });
    expect(result.passed).toBe(true);
  });

  it('fails when expiry is earlier than issue date', () => {
    const result = validateFieldConsistency({
      expiryDate: '2020-01-01',
      extractedFields: { issueDate: '2022-01-01' },
    });
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('Expiry');
  });

  it('passes when expiry is after issue date', () => {
    const result = validateFieldConsistency({
      expiryDate: '2030-01-01',
      extractedFields: { issueDate: '2020-01-01' },
    });
    expect(result.passed).toBe(true);
  });
});
