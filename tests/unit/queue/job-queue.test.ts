import { describe, it, expect, vi, beforeEach } from 'vitest';
import { jobQueue } from '../../../src/services/queue/job-queue';

describe('Job Queue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('add and register', () => {
    it('executes handler when job is added', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      jobQueue.register('test_job', handler);

      const jobId = await jobQueue.add('test_job', { foo: 'bar' });

      await new Promise((r) => setTimeout(r, 50));

      expect(jobId).toBeDefined();
      expect(handler).toHaveBeenCalledWith({ foo: 'bar' });
    });

    it('returns a job id string', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      jobQueue.register('test_job_2', handler);

      const jobId = await jobQueue.add('test_job_2', {});

      expect(typeof jobId).toBe('string');
      expect(jobId).toContain('test_job_2');
    });
  });
});
