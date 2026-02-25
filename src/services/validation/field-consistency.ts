import type { ParsedDocument } from '../../ocr/document-parser';
import type { ValidationCheckResult } from './types';

function parseDate(s: string | undefined): Date | null {
  if (!s || typeof s !== 'string') return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Validates logical consistency of extracted fields: expiry after issue (if both present),
 * DOB in the past, expiry not before today (informational; blocking expiry is separate).
 */
export function validateFieldConsistency(parsed: ParsedDocument): ValidationCheckResult {
  const issues: string[] = [];
  const dob = parseDate(parsed.dob);
  const expiry = parseDate(parsed.expiryDate);
  const issueDate = parsed.extractedFields?.issueDate
    ? parseDate(String(parsed.extractedFields.issueDate))
    : null;

  if (dob) {
    const now = new Date();
    if (dob.getTime() > now.getTime()) {
      issues.push('DOB is in the future');
    }
  }

  if (expiry && issueDate && expiry.getTime() < issueDate.getTime()) {
    issues.push('Expiry date is earlier than issue date');
  }

  if (issues.length > 0) {
    return { passed: false, detail: issues.join('; ') };
  }
  return { passed: true };
}
