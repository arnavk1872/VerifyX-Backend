import type { DocumentType, ParsedDocument } from './document-parser';
import { tryRegexExtraction } from './document-parser';
import { tryGeminiExtraction } from './gemini-extraction';

export interface ExtractDocumentInput {
  s3Key: string;
  documentType: DocumentType;
}

/**
 * Extraction pipeline: General OCR → Gemini → regex fallback.
 * The ID/fraud processor is not used here; it is run separately for fraud detection only.
 */
export async function extractDocumentFields(
  input: ExtractDocumentInput
): Promise<ParsedDocument> {
  const { s3Key, documentType } = input;

  const { extractTextFromS3 } = await import('../services/gcp/document-ai');
  const ocrText = await extractTextFromS3(s3Key);

  const geminiResult = await tryGeminiExtraction(ocrText);
  if (geminiResult?.idNumber) {
    if (!geminiResult.extractedFields.rawText) {
      geminiResult.extractedFields.rawText = ocrText;
    }
    console.log(`[OCR] extractDocumentFields: extracted via Gemini for ${s3Key}`, {
      source: 'gemini',
      fullName: !!geminiResult.fullName,
      idNumber: !!geminiResult.idNumber,
      dob: !!geminiResult.dob,
    });
    return geminiResult;
  }

  const regexResult = tryRegexExtraction(ocrText, documentType);
  console.log(`[OCR] extractDocumentFields: extracted via regex fallback for ${s3Key}`, {
    source: 'regex',
    fullName: !!regexResult.fullName,
    idNumber: !!regexResult.idNumber,
    dob: !!regexResult.dob,
  });
  return regexResult;
}
