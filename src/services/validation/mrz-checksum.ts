import type { ValidationCheckResult } from './types';

/**
 * ICAO 9303 checksum: for each character position, value is 0-9 for digits,
 * 10-35 for A-Z. Weight 7,3,1 repeated. Check digit = sum * weights mod 10.
 */
function icaoCheckDigit(str: string): number {
  const weights = [7, 3, 1];
  let sum = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c === undefined) return -1;
    let val: number;
    if (c >= '0' && c <= '9') val = parseInt(c, 10);
    else if (c >= 'A' && c <= 'Z') val = c.charCodeAt(0) - 55;
    else if (c === '<') val = 0;
    else return -1;
    sum += val * (weights[i % 3] ?? 0);
  }
  return sum % 10;
}

/**
 * Validates MRZ checksum for a single line (e.g. 44 chars). Last character is check digit.
 * If no MRZ string is provided, returns pass (check not run).
 */
export function validateMrzChecksum(mrzLine: string | undefined): ValidationCheckResult {
  if (!mrzLine || typeof mrzLine !== 'string') {
    return { passed: true, detail: 'No MRZ data' };
  }
  const trimmed = mrzLine.trim();
  if (trimmed.length < 2) return { passed: true };

  const data = trimmed.slice(0, -1);
  const expectedCheck = trimmed.slice(-1);
  if (!/^[0-9]$/.test(expectedCheck)) {
    return { passed: false, detail: 'Invalid MRZ check digit character' };
  }
  const expected = parseInt(expectedCheck, 10);
  const computed = icaoCheckDigit(data);
  if (computed < 0) {
    return { passed: false, detail: 'Invalid MRZ characters' };
  }
  if (computed !== expected) {
    return { passed: false, detail: `MRZ checksum mismatch (expected ${expected}, got ${computed})` };
  }
  return { passed: true };
}
