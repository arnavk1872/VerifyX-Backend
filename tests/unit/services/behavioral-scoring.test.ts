import { describe, it, expect } from 'vitest';
import { calculateBehavioralRisk } from '../../../src/services/risk/behavioral-scoring';

describe('Behavioral Scoring', () => {
  describe('calculateBehavioralRisk', () => {
    it('returns score 0 for null or empty signals', () => {
      expect(calculateBehavioralRisk(null)).toEqual({ score: 0, reasons: [] });
      expect(calculateBehavioralRisk(undefined)).toEqual({ score: 0, reasons: [] });
      expect(calculateBehavioralRisk({})).toEqual({ score: 0, reasons: [] });
    });

    it('adds score for many document capture retries', () => {
      const result = calculateBehavioralRisk({
        documentCaptureVisitCount: 5,
      });
      expect(result.score).toBeGreaterThanOrEqual(40);
      expect(result.reasons).toContain('many_document_capture_retries');
    });

    it('adds score for many liveness retries', () => {
      const result = calculateBehavioralRisk({
        livenessVisitCount: 4,
      });
      expect(result.score).toBeGreaterThanOrEqual(40);
      expect(result.reasons).toContain('many_liveness_retries');
    });

    it('adds score for very fast document capture', () => {
      const result = calculateBehavioralRisk({
        stepTimings: {
          capture: { totalTimeMs: 1000, visitCount: 1 },
        },
      });
      expect(result.score).toBeGreaterThanOrEqual(15);
      expect(result.reasons).toContain('very_fast_document_capture');
    });

    it('adds score for very fast liveness capture', () => {
      const result = calculateBehavioralRisk({
        stepTimings: {
          liveness: { totalTimeMs: 2000, visitCount: 1 },
        },
      });
      expect(result.score).toBeGreaterThanOrEqual(20);
      expect(result.reasons).toContain('very_fast_liveness_capture');
    });

    it('caps score at 100', () => {
      const result = calculateBehavioralRisk({
        documentCaptureVisitCount: 10,
        livenessVisitCount: 10,
        stepTimings: {
          capture: { totalTimeMs: 100, visitCount: 1 },
          liveness: { totalTimeMs: 100, visitCount: 1 },
        },
      });
      expect(result.score).toBeLessThanOrEqual(100);
    });
  });
});
