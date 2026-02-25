import { describe, it, expect } from 'vitest';
import { validateMrzChecksum } from '../../../src/services/validation/mrz-checksum';

describe('MRZ Checksum', () => {
  it('passes when no MRZ', () => {
    expect(validateMrzChecksum(undefined)).toEqual({ passed: true, detail: 'No MRZ data' });
    expect(validateMrzChecksum('')).toEqual({ passed: true, detail: 'No MRZ data' });
  });

  it('passes for short string', () => {
    expect(validateMrzChecksum('A')).toEqual({ passed: true });
  });

  it('validates ICAO check digit - single digit data "1" gives check 7', () => {
    const result = validateMrzChecksum('17');
    expect(result.passed).toBe(true);
  });

  it('fails when check digit does not match', () => {
    const result = validateMrzChecksum('12');
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('checksum');
  });
});
