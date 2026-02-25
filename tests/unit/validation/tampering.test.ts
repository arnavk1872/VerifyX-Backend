import { describe, it, expect } from 'vitest';
import { validateTampering } from '../../../src/services/validation/tampering';

describe('Tampering Detection', () => {
  it('passes when no image buffer', async () => {
    const result = await validateTampering(null);
    expect(result.passed).toBe(true);
    expect(result.detail).toBe('No image');
  });

  it('passes when buffer is empty', async () => {
    const result = await validateTampering(Buffer.alloc(0));
    expect(result.passed).toBe(true);
  });
});
