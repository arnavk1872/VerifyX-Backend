export interface BehavioralRiskScore {
  score: number;
  reasons: string[];
}

export function calculateBehavioralRisk(signals: any): BehavioralRiskScore {
  if (!signals || typeof signals !== 'object') {
    return { score: 0, reasons: [] };
  }

  const reasons: string[] = [];
  let score = 0;

  const stepTimings = signals.stepTimings || {};
  const captureTiming = stepTimings['capture'] || stepTimings['document-selection'];
  const livenessTiming = stepTimings['liveness'];

  const documentCaptureVisitCount = Number(signals.documentCaptureVisitCount || 0);
  const livenessVisitCount = Number(signals.livenessVisitCount || 0);

  if (documentCaptureVisitCount > 3) {
    score += 40;
    reasons.push('many_document_capture_retries');
  } else if (documentCaptureVisitCount > 1) {
    score += 15;
    reasons.push('some_document_capture_retries');
  }

  if (livenessVisitCount > 3) {
    score += 40;
    reasons.push('many_liveness_retries');
  } else if (livenessVisitCount > 1) {
    score += 20;
    reasons.push('some_liveness_retries');
  }

  const captureAvgMs =
    captureTiming && captureTiming.totalTimeMs && captureTiming.visitCount
      ? captureTiming.totalTimeMs / captureTiming.visitCount
      : 0;

  const livenessAvgMs =
    livenessTiming && livenessTiming.totalTimeMs && livenessTiming.visitCount
      ? livenessTiming.totalTimeMs / livenessTiming.visitCount
      : 0;

  if (captureAvgMs > 0 && captureAvgMs < 2000) {
    score += 15;
    reasons.push('very_fast_document_capture');
  }

  if (livenessAvgMs > 0 && livenessAvgMs < 3000) {
    score += 20;
    reasons.push('very_fast_liveness_capture');
  }

  if (livenessAvgMs > 120000) {
    score += 15;
    reasons.push('very_slow_liveness_capture');
  }

  score = Math.max(0, Math.min(100, score));

  return {
    score,
    reasons,
  };
}

