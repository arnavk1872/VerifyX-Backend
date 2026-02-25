import { describe, it, expect } from 'vitest';
import { validateCrossFieldConsistency } from '../../../src/services/validation/cross-field-consistency';

describe('Cross-Field Consistency', () => {
  it('passes when no MRZ/barcode data', () => {
    const result = validateCrossFieldConsistency(
      { fullName: 'John', idNumber: '123', extractedFields: {} },
      undefined
    );
    expect(result.passed).toBe(true);
    expect(result.detail).toContain('No MRZ');
  });

  it('passes when names and IDs match', () => {
    const result = validateCrossFieldConsistency(
      { fullName: 'John Doe', idNumber: 'A123', extractedFields: {} },
      { fullName: 'JOHN DOE', idNumber: 'A123' }
    );
    expect(result.passed).toBe(true);
  });

  it('fails when name mismatch', () => {
    const result = validateCrossFieldConsistency(
      { fullName: 'John Doe', idNumber: 'A123', extractedFields: {} },
      { fullName: 'Jane Doe', idNumber: 'A123' }
    );
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('Name');
  });

  it('fails when ID number mismatch', () => {
    const result = validateCrossFieldConsistency(
      { fullName: 'John Doe', idNumber: 'A123', extractedFields: {} },
      { fullName: 'John Doe', idNumber: 'B456' }
    );
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('ID number');
  });
});
