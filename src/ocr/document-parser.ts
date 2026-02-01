export type DocumentType = 'passport' | 'aadhaar' | 'pan' | 'nric';

export interface ParsedDocument {
  fullName?: string;
  dob?: string;
  idNumber?: string;
  address?: string;
  extractedFields: Record<string, any>;
}

export function parseDocumentText(
  rawText: string,
  documentType: DocumentType
): ParsedDocument {
  const lines = rawText.split('\n').map(line => line.trim()).filter(line => line.length > 0);
  
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
      return parsed;
  }
}

function parseNric(lines: string[], parsed: ParsedDocument): ParsedDocument {
  const fullText = lines.join(' ');
  const nricMatch = fullText.match(/([STGF]\d{7}[A-Z])/i);
  if (nricMatch && nricMatch[1]) {
    parsed.idNumber = nricMatch[1].toUpperCase();
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    if (line.match(/^[STGF]\d{7}[A-Z]$/i) && !parsed.idNumber) {
      parsed.idNumber = line.toUpperCase();
    }
    if (line.includes('Name') || line.includes('NAME')) {
      const nextLine = i + 1 < lines.length ? lines[i + 1] : undefined;
      if (nextLine && !parsed.fullName && nextLine.length > 2) {
        parsed.fullName = nextLine.trim();
      }
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
  if (!parsed.fullName && lines.length > 0) {
    const nameLine = lines.find(l => l && l.length > 2 && !l.match(/^[STGF]\d{7}[A-Z]$/i) && !l.match(/^\d/));
    if (nameLine) {
      parsed.fullName = nameLine.trim();
    }
  }
  return parsed;
}

function parsePassport(lines: string[], parsed: ParsedDocument): ParsedDocument {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.toUpperCase();
    if (!line) continue;
    
    if (line.includes('PASSPORT') || line.includes('PASSPORT NO') || line.includes('PASSPORT NUMBER')) {
      const match = line.match(/([A-Z0-9]{6,12})/);
      if (match && match[1] && !parsed.idNumber) {
        parsed.idNumber = match[1];
      }
    }
    
    if (line.includes('NAME') || line.includes('SURNAME') || line.includes('GIVEN NAMES')) {
      const nextLine = i + 1 < lines.length ? lines[i + 1] : undefined;
      if (nextLine && !parsed.fullName) {
        parsed.fullName = nextLine.trim();
      }
    }
    
    if (line.includes('DATE OF BIRTH') || line.includes('DOB') || line.includes('BIRTH')) {
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
    
    if (line.includes('ADDRESS') || line.includes('PLACE OF BIRTH')) {
      const nextLine = i + 1 < lines.length ? lines[i + 1] : undefined;
      if (nextLine && !parsed.address) {
        parsed.address = nextLine.trim();
      }
    }
  }

  if (!parsed.fullName && lines.length > 0 && lines[0]) {
    parsed.fullName = lines[0].trim();
  }

  return parsed;
}

function parseAadhaar(lines: string[], parsed: ParsedDocument): ParsedDocument {
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
    
    if (line.match(/^[A-Z\s]{3,}$/) && !parsed.fullName && !line.includes('GOVERNMENT') && !line.includes('INDIA')) {
      parsed.fullName = line.trim();
    }
    
    if (line.includes('Address') || line.includes('ADDRESS')) {
      if (i + 1 < lines.length && !parsed.address) {
        parsed.address = lines.slice(i + 1, i + 4).join(', ').trim();
      }
    }
  }

  return parsed;
}

function parsePAN(lines: string[], parsed: ParsedDocument): ParsedDocument {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.toUpperCase();
    if (!line) continue;
    
    if (line.match(/^[A-Z]{5}\d{4}[A-Z]$/)) {
      parsed.idNumber = line;
    }
    
    if (line.includes('NAME') || line.includes('NAME OF APPLICANT')) {
      const nextLine = i + 1 < lines.length ? lines[i + 1] : undefined;
      if (nextLine && !parsed.fullName) {
        parsed.fullName = nextLine.trim();
      }
    }
    
    if (line.includes('FATHER') || line.includes('FATHER\'S NAME')) {
      const nextLine = i + 1 < lines.length ? lines[i + 1] : undefined;
      if (nextLine) {
        parsed.extractedFields['fatherName'] = nextLine.trim();
      }
    }
    
    if (line.includes('DATE OF BIRTH') || line.includes('DOB')) {
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
  }

  if (!parsed.fullName && lines.length > 0) {
    const nameLine = lines.find(line => line && line.match(/^[A-Z\s]{3,}$/));
    if (nameLine) {
      parsed.fullName = nameLine.trim();
    }
  }

  return parsed;
}

function normalizeDate(dateStr: string): string {
  const cleaned = dateStr.replace(/[^\d\/\-]/g, '');
  const parts = cleaned.split(/[\/\-]/);
  
  if (parts.length === 3 && parts[0] && parts[1] && parts[2]) {
    const day = parts[0].padStart(2, '0');
    const month = parts[1].padStart(2, '0');
    let year = parts[2];
    
    if (year && year.length === 2) {
      year = parseInt(year) < 50 ? '20' + year : '19' + year;
    }
    
    if (year) {
    return `${year}-${month}-${day}`;
    }
  }
  
  return cleaned;
}

export async function extractAndParseDocument(
  s3Key: string,
  documentType: DocumentType,
  useAnalyzeID: boolean = true
): Promise<ParsedDocument> {
  const { analyzeIDFromS3, extractTextFromS3 } = await import('../services/gcp/document-ai');
  
  let parsed: ParsedDocument;
  
  if (useAnalyzeID) {
    try {
      const analyzed = await analyzeIDFromS3(s3Key);
      const hasMeaningfulData = analyzed.fullName || analyzed.idNumber;
      
      if (hasMeaningfulData) {
        console.log(`[Document Parser] Using structured data from analyzeIDFromS3 for ${s3Key}:`, {
          fullName: analyzed.fullName,
          idNumber: analyzed.idNumber,
        });
        parsed = {
          ...(analyzed.fullName && { fullName: analyzed.fullName }),
          ...(analyzed.dob && { dob: analyzed.dob }),
          ...(analyzed.idNumber && { idNumber: analyzed.idNumber }),
          ...(analyzed.address && { address: analyzed.address }),
          extractedFields: analyzed.extractedFields || {},
        };
      } else {
        console.log(`[Document Parser] No structured data found, falling back to text parsing for ${s3Key}`);
        const rawText = analyzed.rawText || await extractTextFromS3(s3Key);
        parsed = parseDocumentText(rawText, documentType);
        parsed.extractedFields.rawText = rawText;
        if (analyzed.extractedFields) {
          parsed.extractedFields = { ...parsed.extractedFields, ...analyzed.extractedFields };
        }
        console.log(`[Document Parser] Text parsing result:`, {
          fullName: parsed.fullName,
          idNumber: parsed.idNumber,
          rawTextLength: rawText.length,
        });
      }
    } catch (error: any) {
      console.error(`[Document Parser] analyzeIDFromS3 failed for ${s3Key}, falling back to text extraction:`, error);
      const rawText = await extractTextFromS3(s3Key);
      parsed = parseDocumentText(rawText, documentType);
      parsed.extractedFields.rawText = rawText;
    }
  } else {
    const rawText = await extractTextFromS3(s3Key);
    parsed = parseDocumentText(rawText, documentType);
    parsed.extractedFields.rawText = rawText;
  }
  
  return parsed;
}

