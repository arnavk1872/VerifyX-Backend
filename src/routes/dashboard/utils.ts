export function sanitizeDocumentImages(doc: Record<string, any> | null): Record<string, any> | null {
  if (!doc || typeof doc !== 'object') return doc;
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(doc)) {
    if (v && typeof v === 'object' && v.s3Key) {
      out[k] = { ...v, url: undefined };
    }
  }
  return Object.keys(out).length ? out : null;
}
