import { describe, it, expect } from 'vitest';
import {
  detectDocumentType,
  validateDocumentMatch,
  getDocumentSpec,
} from '../../../src/ocr/document-registry';

describe('document-registry', () => {
  describe('getDocumentSpec', () => {
    it('returns spec for known country+type', () => {
      expect(getDocumentSpec('IN', 'aadhaar')).toBeDefined();
      expect(getDocumentSpec('IN', 'aadhaar')?.displayName).toBe('Aadhaar card');
      expect(getDocumentSpec('IN', 'pan')?.displayName).toBe('PAN card');
      expect(getDocumentSpec('SG', 'nric')?.displayName).toBe('NRIC');
    });

    it('returns null for unknown country or type', () => {
      expect(getDocumentSpec('XX', 'aadhaar')).toBeNull();
      expect(getDocumentSpec('IN', 'unknown')).toBeNull();
    });
  });

  describe('detectDocumentType', () => {
    it('detects Aadhaar from keywords and 12-digit id', () => {
      const ocr = 'Government of India\nAadhaar\n1234 5678 9012\nMera Aadhaar, Meri Pehchan';
      expect(detectDocumentType(ocr, '123456789012')).toEqual({
        countryCode: 'IN',
        documentType: 'aadhaar',
      });
    });

    it('detects PAN from keywords and PAN format id', () => {
      const ocr = 'INCOME TAX DEPARTMENT\nPermanent Account Number\nABCDE1234F';
      expect(detectDocumentType(ocr, 'ABCDE1234F')).toEqual({
        countryCode: 'IN',
        documentType: 'pan',
      });
    });

    it('detects NRIC from Singapore IDENTITY CARD and NRIC keywords', () => {
      const ocr = 'IDENTITY CARD NO. S1234567D\nName: John\nNRIC No\nSingapore';
      expect(detectDocumentType(ocr, 'S1234567D')).toEqual({
        countryCode: 'SG',
        documentType: 'nric',
      });
    });

    it('detects Singapore passport before India when SGP keywords present', () => {
      const ocr = 'PASSPORT\nREPUBLIC OF SINGAPORE\nCountry Code: SGP\nK5366852K';
      expect(detectDocumentType(ocr, 'K5366852K')).toEqual({
        countryCode: 'SG',
        documentType: 'passport',
      });
    });

    it('detects India passport from REPUBLIC OF INDIA and P<IND', () => {
      const ocr = 'REPUBLIC OF INDIA\nPassport No: Z1234567\nP<IND';
      expect(detectDocumentType(ocr, 'Z1234567')).toEqual({
        countryCode: 'IN',
        documentType: 'passport',
      });
    });

    it('returns null for empty OCR and no id', () => {
      expect(detectDocumentType('', undefined)).toBeNull();
    });
  });

  describe('validateDocumentMatch', () => {
    it('returns valid when detected type matches requested', () => {
      const ocr = 'Government of India\nAadhaar\n1234 5678 9012';
      const r = validateDocumentMatch(ocr, '123456789012', 'IN', 'aadhaar');
      expect(r.valid).toBe(true);
    });

    it('returns invalid with specific message when user uploaded PAN but requested Aadhaar', () => {
      const ocr = 'INCOME TAX DEPARTMENT\nPermanent Account Number\nABCDE1234F';
      const r = validateDocumentMatch(ocr, 'ABCDE1234F', 'IN', 'aadhaar');
      expect(r.valid).toBe(false);
      expect(r.message).toContain('PAN card');
      expect(r.message).toContain('Aadhaar card');
      expect(r.message).toMatch(/You uploaded a .* Please upload your/);
    });

    it('returns invalid with specific message when user uploaded Aadhaar but requested PAN', () => {
      const ocr = 'Government of India\nAadhaar\n1234 5678 9012';
      const r = validateDocumentMatch(ocr, '123456789012', 'IN', 'pan');
      expect(r.valid).toBe(false);
      expect(r.message).toContain('Aadhaar card');
      expect(r.message).toContain('PAN card');
    });

    it('returns invalid with generic message when document cannot be classified', () => {
      const r = validateDocumentMatch('random text', undefined, 'IN', 'aadhaar');
      expect(r.valid).toBe(false);
      expect(r.message).toContain("doesn't appear to be");
      expect(r.message).toContain('Aadhaar card');
    });

    it('returns valid when no spec for requested type (backward compat)', () => {
      const r = validateDocumentMatch('any text', 'x', 'XX', 'unknown');
      expect(r.valid).toBe(true);
    });
  });
});
