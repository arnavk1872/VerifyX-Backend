import { describe, it, expect } from 'vitest';
import { validateImageQuality } from '../../../src/services/validation/image-quality';

describe('Image Quality', () => {
  it('passes when no image buffer', async () => {
    const result = await validateImageQuality(null);
    expect(result.passed).toBe(true);
    expect(result.detail).toBe('No image');
  });

  it('passes when buffer is empty', async () => {
    const result = await validateImageQuality(Buffer.alloc(0));
    expect(result.passed).toBe(true);
  });
});
