import type { ParsedDocument } from '../../ocr/document-parser';
import type { ValidationCheckResult } from './types';

/**
 * Validates that required OCR fields are present and optionally confidence.
 * Does not block; used for match score and admin visibility.
 */
export function validateOcrFields(
  parsed: ParsedDocument,
  _options?: { minConfidence?: number }
): ValidationCheckResult {
  const missing: string[] = [];
  if (!parsed.fullName || String(parsed.fullName).trim().length === 0) {
    missing.push('name');
  }
  if (!parsed.idNumber || String(parsed.idNumber).trim().length === 0) {
    missing.push('ID number');
  }
  if (missing.length > 0) {
    return { passed: false, detail: `Missing or empty: ${missing.join(', ')}` };
  }
  return { passed: true };
}
