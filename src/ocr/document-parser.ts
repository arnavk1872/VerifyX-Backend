export type DocumentType = 'passport' | 'aadhaar' | 'pan' | 'nric';

export interface ParsedDocument {
  fullName?: string;
  dob?: string;
  idNumber?: string;
  address?: string;
  expiryDate?: string;
  extractedFields: Record<string, any>;
}

function normalizeLine(line: string): string {
  return line.replace(/\s+/g, ' ').trim();
}

export function parseDocumentText(
  rawText: string,
  documentType: DocumentType
): ParsedDocument {
  const lines = rawText
    .split('\n')
    .map((line) => normalizeLine(line))
    .filter((line) => line.length > 0);

  const parsed: ParsedDocument = {
    extractedFields: {},
  };

  switch (documentType) {
    case 'passport':
      return parsePassport(lines, parsed);
    case 'aadhaar':
      return parseAadhaar(lines, parsed);
    case 'pan':
      return parsePAN(lines, parsed);
    case 'nric':
      return parseNric(lines, parsed);
    default:
      return parseGeneric(lines, parsed);
  }
}

/** Regex fallback wrapper: returns parseDocumentText result with rawText attached. */
export function tryRegexExtraction(ocrText: string, documentType: DocumentType): ParsedDocument {
  const parsed = parseDocumentText(ocrText, documentType);
  parsed.extractedFields.rawText = ocrText;
  return parsed;
}

/** Non-country-specific best-effort extraction for unknown document types. */
function parseGeneric(lines: string[], parsed: ParsedDocument): ParsedDocument {
  const fullText = lines.join('\n');
  if (!parsed.fullName) {
    const name = extractNameFromLabels(lines);
    if (name) parsed.fullName = name;
  }
  if (!parsed.idNumber) {
    const idMatch = fullText.match(/([A-Z0-9]{6,12})/);
    if (idMatch && idMatch[1]) parsed.idNumber = idMatch[1];
  }
  if (!parsed.idNumber) {
    const aadhaarMatch = fullText.match(/(\d{4}\s?\d{4}\s?\d{4})/);
    if (aadhaarMatch && aadhaarMatch[1]) parsed.idNumber = aadhaarMatch[1].replace(/\s/g, '');
  }
  const dateMatch = fullText.match(/(\d{1,2}[\/\-]\s*\d{1,2}[\/\-]\s*\d{2,4})/);
  if (dateMatch && dateMatch[1] && !parsed.dob) parsed.dob = normalizeDate(dateMatch[1]);
  if (!parsed.expiryDate) {
    const expiry = extractExpiryFromText(fullText);
    if (expiry) parsed.expiryDate = expiry;
  }
  return parsed;
}

function parseNric(lines: string[], parsed: ParsedDocument): ParsedDocument {
  const fullText = lines.join(' ');
  const nricMatch = fullText.match(/([STGF]\d{7}[A-Z])/i);
  if (nricMatch && nricMatch[1]) {
    parsed.idNumber = nricMatch[1].toUpperCase();
  }

  if (!parsed.fullName) {
    const name = extractNameFromLabels(lines);
    if (name) parsed.fullName = name;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    if (line.match(/^[STGF]\d{7}[A-Z]$/i) && !parsed.idNumber) {
      parsed.idNumber = line.toUpperCase();
    }
    if (line.includes('Date of Birth') || line.includes('DOB') || line.includes('Birth')) {
      const dateMatch = line.match(/(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/);
      if (dateMatch && dateMatch[1]) {
        parsed.dob = normalizeDate(dateMatch[1]);
      } else if (i + 1 < lines.length) {
        parsed.dob = normalizeDate(lines[i + 1] || '');
      }
    }
  }

  if (!parsed.expiryDate) {
    const expiry = extractExpiryFromText(fullText);
    if (expiry) parsed.expiryDate = expiry;
  }
  return parsed;
}

function parsePassport(lines: string[], parsed: ParsedDocument): ParsedDocument {
  const fullText = lines.join('\n');

  if (!parsed.fullName) {
    const name = extractNameFromLabels(lines);
    if (name !== undefined) {
      parsed.fullName = name;
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.toUpperCase();
    if (!line) continue;

    if (line.includes('PASSPORT') || line.includes('PASSPORT NO') || line.includes('PASSPORT NUMBER')) {
      const match = line.match(/([A-Z0-9]{6,12})/);
      if (match && match[1] && !parsed.idNumber) {
        parsed.idNumber = match[1];
      }
    }

    if (line.includes('DATE OF BIRTH') || line.includes('DOB') || line.includes('BIRTH')) {
      const dateMatch = line.match(/(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/);
      if (dateMatch && dateMatch[1]) {
        parsed.dob = normalizeDate(dateMatch[1]);
      } else {
        const nextLine = i + 1 < lines.length ? lines[i + 1] : undefined;
        if (nextLine) parsed.dob = normalizeDate(nextLine);
      }
    }

    if (line.includes('ADDRESS') || line.includes('PLACE OF BIRTH')) {
      const nextLine = i + 1 < lines.length ? lines[i + 1] : undefined;
      if (nextLine && !parsed.address) parsed.address = nextLine.trim();
    }
  }

  if (!parsed.expiryDate) {
    const expiry = extractExpiryFromText(fullText);
    if (expiry) parsed.expiryDate = expiry;
  }

  return parsed;
}

const NAME_LABELS = [
  'Name',
  'NAME',
  'Full Name',
  'Full name',
  'NAME OF APPLICANT',
  'Given Names',
  'Name of holder',
  'Nom',
  'Nombre',
  'Holder name',
];

function isNameCandidate(line: string): boolean {
  const t = line.trim();
  return t.length >= 3 && /^[A-Za-z\s.\-']+$/.test(t);
}

/** Label-value extraction: name is the line before DOB/Date of Birth, or after Name/NAME. Multiple candidate lines (next 1-2) considered. */
function extractNameFromLabels(lines: string[]): string | undefined {
  for (let i = 0; i < lines.length; i++) {
    const line = normalizeLine(lines[i] ?? '');
    if (!line) continue;

    const isNameLabel = NAME_LABELS.some((l) => line.includes(l));
    if (isNameLabel) {
      for (let j = 1; j <= 2 && i + j < lines.length; j++) {
        const candidate = normalizeLine(lines[i + j] ?? '');
        if (isNameCandidate(candidate)) return candidate;
      }
    }

    if (
      line.includes('DOB') ||
      line.includes('Date of Birth') ||
      line.includes('Year of Birth') ||
      /dob\s*:/i.test(line)
    ) {
      if (i > 0) {
        const prevLine = normalizeLine(lines[i - 1] ?? '');
        if (isNameCandidate(prevLine)) return prevLine;
      }
    }
  }
  return undefined;
}

function parseAadhaar(lines: string[], parsed: ParsedDocument): ParsedDocument {
  const fullText = lines.join('\n');

  if (!parsed.fullName) {
    const name = extractNameFromLabels(lines);
    if (name) parsed.fullName = name;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    if (line.match(/^\d{4}\s?\d{4}\s?\d{4}$/)) {
      parsed.idNumber = line.replace(/\s/g, '');
    }

    if (line.includes('DOB') || line.includes('Date of Birth') || line.includes('Year of Birth')) {
      const dateMatch = line.match(/(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/);
      if (dateMatch && dateMatch[1]) {
        parsed.dob = normalizeDate(dateMatch[1]);
      } else {
        const nextLine = i + 1 < lines.length ? lines[i + 1] : undefined;
        if (nextLine) {
          parsed.dob = normalizeDate(nextLine);
        }
      }
    }

    if (line.includes('Address') || line.includes('ADDRESS')) {
      if (i + 1 < lines.length && !parsed.address) {
        parsed.address = lines.slice(i + 1, i + 4).join(', ').trim();
      }
    }
  }

  if (!parsed.expiryDate) {
    const expiry = extractExpiryFromText(fullText);
    if (expiry) parsed.expiryDate = expiry;
  }

  return parsed;
}

function parsePAN(lines: string[], parsed: ParsedDocument): ParsedDocument {
  const fullText = lines.join('\n');

  if (!parsed.fullName) {
    const name = extractNameFromLabels(lines);
    if (name) parsed.fullName = name;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.toUpperCase();
    if (!line) continue;

    if (line.match(/^[A-Z]{5}\d{4}[A-Z]$/)) {
      parsed.idNumber = line;
    }

    if (line.includes('FATHER') || line.includes("FATHER'S NAME")) {
      const nextLine = i + 1 < lines.length ? lines[i + 1] : undefined;
      if (nextLine) parsed.extractedFields['fatherName'] = nextLine.trim();
    }

    if (line.includes('DATE OF BIRTH') || line.includes('DOB')) {
      const dateMatch = line.match(/(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/);
      if (dateMatch && dateMatch[1]) {
        parsed.dob = normalizeDate(dateMatch[1]);
      } else {
        const nextLine = i + 1 < lines.length ? lines[i + 1] : undefined;
        if (nextLine) parsed.dob = normalizeDate(nextLine);
      }
    }
  }

  if (!parsed.expiryDate) {
    const expiry = extractExpiryFromText(fullText);
    if (expiry) parsed.expiryDate = expiry;
  }

  return parsed;
}

function extractExpiryFromText(text: string): string | undefined {
  if (!text) return undefined;
  const keywords = [
    'date of expiry',
    'expiry date',
    'expiration date',
    'valid until',
    'valid till',
    'expires',
  ];

  const lines = text.split('\n');
  for (const line of lines) {
    const lower = line.toLowerCase();
    if (!keywords.some((k) => lower.includes(k))) continue;
    const dateMatch = line.match(/(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/);
    if (dateMatch && dateMatch[1]) {
      return normalizeDate(dateMatch[1]);
    }
  }

  const fallbackMatch = text.match(
    /(?:exp|expiry|expiration|valid)\s*[:\s]*\d{0,2}\s*(\d{1,2}[\/\-]\s*\d{1,2}[\/\-]\s*\d{2,4})/i
  );
  if (fallbackMatch?.[1]) return normalizeDate(fallbackMatch[1]);
  const fallbackMatch2 = text.match(
    /(?:exp|expiry|expiration|valid)[^0-9]{0,12}(\d{1,2}[\/\-]\s*\d{1,2}[\/\-]\s*\d{2,4})/i
  );
  if (fallbackMatch2?.[1]) return normalizeDate(fallbackMatch2[1]);

  return undefined;
}

/** Parses DD/MM/YYYY or DD-MM-YYYY and returns ISO YYYY-MM-DD for DB storage. Leaves already-ISO strings unchanged. */
export function normalizeDate(dateStr: string): string {
  const trimmed = dateStr.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const cleaned = dateStr.replace(/[^\d\/\-]/g, '');
  const parts = cleaned.split(/[\/\-]/);

  if (parts.length === 3 && parts[0] && parts[1] && parts[2]) {
    const day = parts[0].padStart(2, '0');
    const month = parts[1].padStart(2, '0');
    let year = parts[2];

    if (year && year.length === 2) {
      year = parseInt(year, 10) < 50 ? '20' + year : '19' + year;
    }

    if (year) {
      return `${year}-${month}-${day}`;
    }
  }

  return cleaned;
}

