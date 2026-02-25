import type { ParsedDocument } from '../../ocr/document-parser';
import type { ValidationCheckResult } from './types';

function normalizeForCompare(s: string | undefined): string {
  if (!s || typeof s !== 'string') return '';
  return s
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Compares name and ID number across visual extraction and MRZ/barcode when available.
 * If no MRZ or barcode data, returns pass (check not run).
 */
export function validateCrossFieldConsistency(
  parsed: ParsedDocument,
  mrzOrBarcode?: { fullName?: string; idNumber?: string }
): ValidationCheckResult {
  if (!mrzOrBarcode || (mrzOrBarcode.fullName === undefined && mrzOrBarcode.idNumber === undefined)) {
    return { passed: true, detail: 'No MRZ/barcode to compare' };
  }

  const issues: string[] = [];
  const visualName = normalizeForCompare(parsed.fullName);
  const visualId = normalizeForCompare(parsed.idNumber);
  const otherName = normalizeForCompare(mrzOrBarcode.fullName);
  const otherId = normalizeForCompare(mrzOrBarcode.idNumber);

  if (otherName && visualName && visualName !== otherName) {
    issues.push('Name mismatch between document and MRZ/barcode');
  }
  if (otherId && visualId && visualId !== otherId) {
    issues.push('ID number mismatch between document and MRZ/barcode');
  }

  if (issues.length > 0) {
    return { passed: false, detail: issues.join('; ') };
  }
  return { passed: true };
}
