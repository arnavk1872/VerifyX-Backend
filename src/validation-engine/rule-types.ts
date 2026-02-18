import type { ParsedDocument } from '../ocr/document-parser';

export interface ValidationContext {
  parsedDocument?: ParsedDocument;
  videoKey?: string;
  verificationId?: string;
}

export interface ValidationRule {
  id: string;
  enabled: boolean;
  validate(ctx: ValidationContext): Promise<boolean>;
}

export interface ValidationResult {
  ruleId: string;
  passed: boolean;
}
