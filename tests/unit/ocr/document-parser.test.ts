import { describe, it, expect } from 'vitest';
import { parseDocumentText } from '../../../src/ocr/document-parser';

describe('Document Parser', () => {
  describe('parseDocumentText', () => {
    describe('passport', () => {
      it('extracts fullName and idNumber from passport text', () => {
        const rawText = `PASSPORT
PASSPORT NO: AB123456
NAME
John Doe
DATE OF BIRTH
01/01/1990`;
        const result = parseDocumentText(rawText, 'passport');
        expect(result.fullName).toBe('John Doe');
        expect(result.idNumber).toBeDefined();
      });
    });

    describe('aadhaar', () => {
      it('extracts idNumber from 12-digit format', () => {
        const rawText = `1234 5678 9012
Name
John Doe`;
        const result = parseDocumentText(rawText, 'aadhaar');
        expect(result.idNumber).toBe('123456789012');
      });

      it('extracts name from line before DOB, not header text like HIRE FRE', () => {
        const rawText = `HIRE FRE
Government of India
T
Arnav Khajuria
Date of Birth/DOB: 18/07/2002
Male/ MALE
Aadhaar no. issued: 07/01/2016
3091 8083 8896`;
        const result = parseDocumentText(rawText, 'aadhaar');
        expect(result.fullName).toBe('Arnav Khajuria');
        expect(result.fullName).not.toBe('HIRE FRE');
        expect(result.dob).toBeDefined();
        expect(result.idNumber).toBe('309180838896');
      });
    });

    describe('pan', () => {
      it('extracts PAN number from valid format', () => {
        const rawText = `INCOME TAX
ABCDE1234F
NAME OF APPLICANT
John Doe`;
        const result = parseDocumentText(rawText, 'pan');
        expect(result.idNumber).toBe('ABCDE1234F');
      });
    });

    describe('nric', () => {
      it('extracts NRIC number from Singapore format', () => {
        const rawText = `Name
John Doe
NRIC
S1234567A`;
        const result = parseDocumentText(rawText, 'nric');
        expect(result.idNumber).toBe('S1234567A');
      });
    });

    describe('empty or invalid input', () => {
      it('returns empty parsed for empty text', () => {
        const result = parseDocumentText('', 'passport');
        expect(result.fullName).toBeUndefined();
        expect(result.idNumber).toBeUndefined();
        expect(result.extractedFields).toEqual({});
      });
    });
  });
});
