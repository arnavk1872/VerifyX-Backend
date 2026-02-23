import { GoogleGenAI } from '@google/genai';
import type { ParsedDocument } from './document-parser';
import { normalizeDate } from './document-parser';

const SCHEMA_JSON = `{
  "fullName": "",
  "idNumber": "",
  "dateOfBirth": "",
  "expiryDate": "",
  "address": ""
}`;

const PROMPT_PREFIX = `Extract the following fields from the OCR text.
Return STRICT JSON only. No markdown, no code fences, no explanation.
Use empty string "" for any field not found.

For dateOfBirth and expiryDate: use the exact format as on the document (e.g. DD-MM-YYYY or DD/MM/YYYY). Use only numbers and separators (slash or hyphen). Do NOT use day names (e.g. Thursday), month names (e.g. July), or ordinals (e.g. 18th).

Schema:
`;

function safeJsonParse<T = unknown>(text: string): T | null {
  try {
    const stripped = text
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/g, '')
      .trim();
    return JSON.parse(stripped) as T;
  } catch {
    return null;
  }
}

interface GeminiExtractionSchema {
  fullName?: string;
  idNumber?: string;
  dateOfBirth?: string;
  expiryDate?: string;
  address?: string;
}

function toParsedDocument(raw: GeminiExtractionSchema, ocrText: string): ParsedDocument {
  const fullName = typeof raw.fullName === 'string' ? raw.fullName.trim() || undefined : undefined;
  const idNumber = typeof raw.idNumber === 'string' ? raw.idNumber.trim() || undefined : undefined;
  const dobRaw = typeof raw.dateOfBirth === 'string' ? raw.dateOfBirth.trim() || undefined : undefined;
  const dob = dobRaw ? normalizeDate(dobRaw) : undefined;
  const expiryRaw = typeof raw.expiryDate === 'string' ? raw.expiryDate.trim() || undefined : undefined;
  const expiryDate = expiryRaw ? normalizeDate(expiryRaw) : undefined;
  const address = typeof raw.address === 'string' ? raw.address.trim() || undefined : undefined;

  const doc: ParsedDocument = { extractedFields: { rawText: ocrText } };
  if (fullName !== undefined) doc.fullName = fullName;
  if (idNumber !== undefined) doc.idNumber = idNumber;
  if (dob !== undefined) doc.dob = dob;
  if (dobRaw !== undefined) doc.extractedFields.dobDisplay = dobRaw;
  if (expiryDate !== undefined) doc.expiryDate = expiryDate;
  if (expiryRaw !== undefined) doc.extractedFields.expiryDateDisplay = expiryRaw;
  if (address !== undefined) doc.address = address;
  return doc;
}

/**
 * Try to extract document fields from OCR text using Gemini. Returns null if API key missing or parse fails (after one retry).
 */
export async function tryGeminiExtraction(ocrText: string): Promise<ParsedDocument | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const prompt = `${PROMPT_PREFIX}${SCHEMA_JSON}

OCR TEXT:
${ocrText}`;

  const tryOnce = async (): Promise<ParsedDocument | null> => {
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model: 'gemini-2.0-flash',
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
    });

    const res = response as { text?: string; candidates?: { content?: { parts?: { text?: string }[] } }[] };
    const text =
      res.text ??
      res.candidates?.[0]?.content?.parts?.[0]?.text ??
      '';
    const parsed = safeJsonParse<GeminiExtractionSchema>(text);
    if (!parsed || typeof parsed !== 'object') return null;
    return toParsedDocument(parsed, ocrText);
  };

  let result = await tryOnce();
  if (result === null) {
    result = await tryOnce();
  }
  return result;
}
