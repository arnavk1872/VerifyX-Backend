/**
 * Document registry: single source of truth per (countryCode, documentType).
 * Used to validate that an uploaded document matches the selected type and to
 * detect wrong-document uploads for specific error messages.
 * Adding new countries/document types = adding entries here (no logic change).
 */

export interface DocumentSpec {
  countryCode: string;
  documentType: string;
  idNumberPattern: RegExp;
  requiredKeywords: string[];
  displayName: string;
  forbiddenKeywords?: string[];
}

const SPECS: DocumentSpec[] = [
  {
    countryCode: 'IN',
    documentType: 'aadhaar',
    idNumberPattern: /\b\d{4}\s?\d{4}\s?\d{4}\b/,
    requiredKeywords: [
      'aadhaar',
      'government of india',
      'भारत सरकार',
      'mera aadhaar',
      'meri pehchan',
      'aadhaar is proof of identity',
      'offline xml',
      'qr code',
      'date of birth',
      'dob',
    ],
    displayName: 'Aadhaar card',
  },
  {
    countryCode: 'IN',
    documentType: 'pan',
    idNumberPattern: /\b[A-Z]{5}[0-9]{4}[A-Z]\b/,
    requiredKeywords: [
      'income tax department',
      'आयकर विभाग',
      'permanent account number',
      'pan',
      'pan application digitally signed',
      'govt. of india',
      'government of india',
    ],
    displayName: 'PAN card',
  },
  {
    countryCode: 'IN',
    documentType: 'passport',
    idNumberPattern: /\b[A-Z][0-9]{7}\b/,
    requiredKeywords: [
      'republic of india',
      'भारत गणराज्य',
      'passport no',
      'passport number',
      'code: ind',
      'nationality: indian',
      'p<ind',
      'type: p',
    ],
    displayName: 'Passport',
  },
  {
    countryCode: 'SG',
    documentType: 'nric',
    idNumberPattern: /\b[STFG]\d{7}[A-Z]\b/i,
    requiredKeywords: [
      'republic of singapore',
      'identity card no',
      'nric',
      'nric no',
      'race',
      'date of issue',
      'singapore',
    ],
    displayName: 'NRIC',
  },
  {
    countryCode: 'SG',
    documentType: 'passport',
    idNumberPattern: /\b[A-Z]\d{7}[A-Z]\b/,
    requiredKeywords: [
      'passport',
      'republic of singapore',
      'passport no',
      'passport number',
      'country code: sgp',
      'sgp',
      'singapore citizen',
      'ministry of home affairs',
      'p<sgp',
    ],
    displayName: 'Passport',
  },
];

/** Detection order: more specific docs first to avoid misclassification. */
const DETECTION_ORDER: { countryCode: string; documentType: string }[] = [
  { countryCode: 'SG', documentType: 'passport' },
  { countryCode: 'IN', documentType: 'passport' },
  { countryCode: 'SG', documentType: 'nric' },
  { countryCode: 'IN', documentType: 'pan' },
  { countryCode: 'IN', documentType: 'aadhaar' },
];

const SPEC_MAP = new Map<string, DocumentSpec>();
for (const spec of SPECS) {
  SPEC_MAP.set(specKey(spec.countryCode, spec.documentType), spec);
}

function specKey(countryCode: string, documentType: string): string {
  return `${countryCode.toUpperCase()}|${documentType.toLowerCase()}`;
}

function normalizeOcr(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function getDocumentSpec(
  countryCode: string,
  documentType: string
): DocumentSpec | null {
  return SPEC_MAP.get(specKey(countryCode, documentType)) ?? null;
}

export function getDetectionOrder(): Array<{ countryCode: string; documentType: string }> {
  return [...DETECTION_ORDER];
}

/**
 * Detect document type from OCR text and optionally extracted ID number.
 * Uses fixed detection order so more specific docs (e.g. Singapore passport) match before generic ones.
 */
export function detectDocumentType(
  ocrText: string,
  extractedIdNumber: string | undefined
): { countryCode: string; documentType: string } | null {
  const normalized = normalizeOcr(ocrText);
  if (!normalized && !extractedIdNumber) return null;

  const idNum = (extractedIdNumber ?? '').trim();

  for (const { countryCode, documentType } of DETECTION_ORDER) {
    const spec = getDocumentSpec(countryCode, documentType);
    if (!spec) continue;

    const keywordMatch = spec.requiredKeywords.some((kw) => normalized.includes(kw));
    const idMatch = spec.idNumberPattern.test(idNum) || spec.idNumberPattern.test(normalized);

    if (keywordMatch && (idMatch || !idNum)) {
      if (spec.forbiddenKeywords?.some((kw) => normalized.includes(kw))) continue;
      return { countryCode, documentType };
    }
  }

  return null;
}

export interface ValidateDocumentMatchResult {
  valid: boolean;
  detected?: { countryCode: string; documentType: string };
  message?: string;
}

/**
 * Validate that the uploaded document matches the requested type.
 * Returns valid: false with a specific message when wrong document is detected
 * (e.g. "You uploaded a PAN card. Please upload your Aadhaar card.").
 */
export function validateDocumentMatch(
  ocrText: string,
  extractedIdNumber: string | undefined,
  countryCode: string,
  requestedType: string
): ValidateDocumentMatchResult {
  const requestedSpec = getDocumentSpec(countryCode, requestedType);

  if (!requestedSpec) {
    return { valid: true };
  }

  const detected = detectDocumentType(ocrText, extractedIdNumber);

  if (!detected) {
    return {
      valid: false,
      message: `The document doesn't appear to be a ${requestedSpec.displayName}. Please upload the correct document.`,
    };
  }

  const detectedKey = specKey(detected.countryCode, detected.documentType);
  const reqKey = specKey(countryCode, requestedType);
  if (detectedKey === reqKey) {
    return { valid: true, detected };
  }

  const detectedSpec = getDocumentSpec(detected.countryCode, detected.documentType);
  const detectedDisplayName = detectedSpec?.displayName ?? detected.documentType;

  return {
    valid: false,
    detected: { countryCode: detected.countryCode, documentType: detected.documentType },
    message: `You uploaded a ${detectedDisplayName}. Please upload your ${requestedSpec.displayName}.`,
  };
}
