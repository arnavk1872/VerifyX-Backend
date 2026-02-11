import { pool } from '../../db/pool';
import { deliverWebhook } from '../webhooks/deliver';
import { compareFaces, detectFaces } from '../gcp/vision';
import { detectFacesInVideo } from '../gcp/video-liveness';
import { extractAndParseDocument } from '../../ocr/document-parser';
import type { DocumentType } from '../../ocr/document-parser';
import { analyzeSpoofSignalsForImages } from './spoof-detection';
import { calculateBehavioralRisk } from '../risk/behavioral-scoring';

export interface ProcessingResult {
  checks: {
    liveness?: 'pass' | 'fail' | 'unknown';
    faceMatch?: string;
    documentValid?: boolean;
    ocrMatch?: boolean;
    [key: string]: any;
  };
  riskSignals: {
    verified?: boolean;
    suspiciousPatterns?: string[];
    flags?: string[];
    [key: string]: any;
  };
  rawResponse: Record<string, any>;
}

function isDocumentExpired(expiryDateStr: string): boolean {
  if (!expiryDateStr) return false;
  const expiry = new Date(expiryDateStr);
  if (Number.isNaN(expiry.getTime())) {
    return false;
  }
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return expiry.getTime() < today.getTime();
}

export async function processVerification(verificationId: string): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const verificationResult = await client.query(
      `SELECT v.id, v.organization_id, v.id_type, v.status,
              pii.document_images, pii.full_name
       FROM verifications v
       LEFT JOIN verification_pii pii ON v.id = pii.verification_id
       WHERE v.id = $1`,
      [verificationId]
    );

    if (verificationResult.rows.length === 0) {
      throw new Error('Verification not found');
    }

    const verification = verificationResult.rows[0];
    const documentImages = verification.document_images || {};

    const orgRulesResult = await client.query(
      'SELECT verification_rules FROM organizations WHERE id = $1',
      [verification.organization_id]
    );
    const rawRules =
      (orgRulesResult.rows[0]?.verification_rules as {
        documentExpiryCheckEnabled?: boolean;
        ghostSpoofCheckEnabled?: boolean;
        behavioralFraudCheckEnabled?: boolean;
      }) || {};
    const verificationRules = {
      documentExpiryCheckEnabled: rawRules.documentExpiryCheckEnabled === true,
      ghostSpoofCheckEnabled: rawRules.ghostSpoofCheckEnabled === true,
      behavioralFraudCheckEnabled: rawRules.behavioralFraudCheckEnabled === true,
    };

    const behaviorResult = await client.query(
      'SELECT signals FROM verification_behavior WHERE verification_id = $1',
      [verificationId]
    );
    const behavioralSignals = behaviorResult.rows[0]?.signals || null;

    const result: ProcessingResult = {
      checks: {},
      riskSignals: {},
      rawResponse: {},
    };

    let documentExpired = false;
    let spoofDetected = false;
    let behavioralFraudDetected = false;

    const documentS3Key = documentImages.document?.s3Key;
    const livenessS3Key = documentImages.liveness?.s3Key;

    if (documentS3Key) {
      try {
        const parsedDoc = await extractAndParseDocument(
          documentS3Key,
          verification.id_type as DocumentType,
          true
        );

        result.checks.documentValid = !!(parsedDoc.fullName && parsedDoc.idNumber);
        result.checks.ocrMatch = !!(parsedDoc.fullName && parsedDoc.idNumber);
        result.rawResponse.ocr = {
          extracted: {
            fullName: parsedDoc.fullName || null,
            idNumber: parsedDoc.idNumber || null,
            dob: parsedDoc.dob || null,
            address: parsedDoc.address || null,
            documentExpiryDate: parsedDoc.expiryDate || null,
          },
          rawText: parsedDoc.extractedFields?.rawText || null,
          extractedFields: parsedDoc.extractedFields || {},
        };

        if (parsedDoc.expiryDate && verificationRules.documentExpiryCheckEnabled) {
          const expired = isDocumentExpired(parsedDoc.expiryDate);
          documentExpired = expired;
          result.checks.documentExpiry = expired ? 'fail' : 'pass';
          if (!result.riskSignals.flags) {
            result.riskSignals.flags = [];
          }
          if (expired) {
            result.riskSignals.flags.push('document_expired');
          }
        }

        if (parsedDoc.fullName) {
          const existingPii = await client.query(
            `SELECT verification_id FROM verification_pii WHERE verification_id = $1`,
            [verificationId]
          );

          if (existingPii.rows.length > 0) {
            await client.query(
              `UPDATE verification_pii SET full_name = $1 WHERE verification_id = $2`,
              [parsedDoc.fullName, verificationId]
            );
          } else {
            await client.query(
              `INSERT INTO verification_pii (verification_id, full_name) VALUES ($1, $2)`,
              [verificationId, parsedDoc.fullName]
            );
          }
        }

        if (parsedDoc.expiryDate) {
          await client.query(
            `INSERT INTO verification_pii (verification_id, document_expiry_date)
             VALUES ($1, $2)
             ON CONFLICT (verification_id) DO UPDATE
             SET document_expiry_date = COALESCE(verification_pii.document_expiry_date, EXCLUDED.document_expiry_date),
                 document_expired = COALESCE(verification_pii.document_expired, $3)`,
            [verificationId, parsedDoc.expiryDate, isDocumentExpired(parsedDoc.expiryDate)]
          );
        }
      } catch (error: any) {
        result.checks.documentValid = false;
        result.checks.ocrMatch = false;
        result.rawResponse.ocrError = error instanceof Error ? error.message : 'Unknown error';
        console.error(`[Processor] OCR extraction failed for verification ${verificationId}:`, error);
      }
    }

    if (documentS3Key && livenessS3Key) {
      try {
        const livenessType = documentImages.liveness?.type;

        if (livenessType === 'video') {
          const videoFaces = await detectFacesInVideo(livenessS3Key);
          result.checks.liveness = videoFaces.hasFace ? 'pass' : 'fail';
          result.rawResponse.liveness = {
            type: 'video',
            faceDetected: videoFaces.hasFace,
            faceCount: videoFaces.faceCount,
          };
          if (videoFaces.hasFace) {
            const documentFaces = await detectFaces(documentS3Key);
            result.checks.faceMatch = documentFaces.hasFace ? 'detected' : 'no_document_face';
            result.rawResponse.faceMatch = {
              documentFaces: documentFaces.faceCount,
              videoFaces: videoFaces.faceCount,
              type: 'document_and_video',
            };
          }
        } else {
          const faceMatch = await compareFaces(documentS3Key, livenessS3Key, 80);
          result.checks.faceMatch = `${Math.round(faceMatch.similarity)}%`;
          result.checks.liveness = faceMatch.isMatch ? 'pass' : 'fail';
          result.rawResponse.faceMatch = {
            similarity: faceMatch.similarity,
            isMatch: faceMatch.isMatch,
            confidence: faceMatch.confidence,
            type: 'image_comparison',
          };
        }
      } catch (error: any) {
        result.checks.liveness = 'unknown';
        result.rawResponse.faceMatchError = error instanceof Error ? error.message : 'Unknown error';
      }
    } else if (documentS3Key && !livenessS3Key) {
      try {
        const documentFaces = await detectFaces(documentS3Key);
        result.checks.liveness = documentFaces.hasFace ? 'pass' : 'fail';
        result.rawResponse.liveness = {
          type: 'document_only',
          faceDetected: documentFaces.hasFace,
          faceCount: documentFaces.faceCount,
        };
      } catch (error: any) {
        result.checks.liveness = 'unknown';
        result.rawResponse.livenessError = error instanceof Error ? error.message : 'Unknown error';
      }
    }

    if ((documentS3Key || livenessS3Key) && verificationRules.ghostSpoofCheckEnabled) {
      try {
        const imageKeys: string[] = [];
        if (documentS3Key) imageKeys.push(documentS3Key);
        if (livenessS3Key) imageKeys.push(livenessS3Key);

        const spoofResult = await analyzeSpoofSignalsForImages(imageKeys);
        result.rawResponse.spoofDetection = spoofResult;

        if (spoofResult.spoofRiskScore >= 70) {
          spoofDetected = true;
          result.checks.spoofDetection = {
            status: 'failed',
            score: spoofResult.spoofRiskScore,
            signals: spoofResult.signals,
          };
          if (!result.riskSignals.flags) {
            result.riskSignals.flags = [];
          }
          result.riskSignals.flags.push('spoof_detected');
          result.riskSignals.spoofDetected = spoofResult;
        } else if (spoofResult.spoofRiskScore > 0) {
          result.checks.spoofDetection = {
            status: 'passed',
            score: spoofResult.spoofRiskScore,
            signals: spoofResult.signals,
          };
          result.riskSignals.spoofDetected = spoofResult;
        }
      } catch (error: any) {
        result.rawResponse.spoofDetectionError =
          error instanceof Error ? error.message : 'Unknown error';
      }
    }

    if (verificationRules.behavioralFraudCheckEnabled && behavioralSignals) {
      const behavioral = calculateBehavioralRisk(behavioralSignals);
      result.rawResponse.behavioral = {
        score: behavioral.score,
        reasons: behavioral.reasons,
        signals: behavioralSignals,
      };
      if (behavioral.score >= 70) {
        behavioralFraudDetected = true;
        result.checks.behavioralFraud = {
          status: 'failed',
          score: behavioral.score,
          reasons: behavioral.reasons,
        };
        if (!result.riskSignals.flags) {
          result.riskSignals.flags = [];
        }
        result.riskSignals.flags.push('behavioral_fraud');
        result.riskSignals.behavioralFraud = {
          score: behavioral.score,
          reasons: behavioral.reasons,
        };
      } else if (behavioral.score > 0) {
        result.checks.behavioralFraud = {
          status: 'passed',
          score: behavioral.score,
          reasons: behavioral.reasons,
        };
        result.riskSignals.behavioralFraud = {
          score: behavioral.score,
          reasons: behavioral.reasons,
        };
      }
    }

    const faceMatchScore = result.checks.faceMatch
      ? (result.checks.faceMatch === 'detected' ? 100 : parseFloat(result.checks.faceMatch.replace('%', '')))
      : null;

    const allChecksPassed =
      result.checks.documentValid === true &&
      result.checks.liveness === 'pass' &&
      (faceMatchScore === null || faceMatchScore >= 80 || faceMatchScore === 100) &&
      !documentExpired &&
      !spoofDetected &&
      !behavioralFraudDetected;

    result.riskSignals.verified = allChecksPassed;

    if (!allChecksPassed) {
      result.riskSignals.flags = [];
      if (result.checks.documentValid === false) {
        result.riskSignals.flags.push('document_validation_failed');
      }
      if (documentExpired) {
        result.riskSignals.flags.push('document_expired');
      }
      if (spoofDetected) {
        result.riskSignals.flags.push('spoof_detected');
      }
      if (behavioralFraudDetected) {
        result.riskSignals.flags.push('behavioral_fraud');
      }
      if (result.checks.liveness !== 'pass') {
        result.riskSignals.flags.push('liveness_check_failed');
      }
      if (result.checks.faceMatch && result.checks.faceMatch !== 'detected') {
        const faceMatchScore = parseFloat(result.checks.faceMatch.replace('%', ''));
        if (!isNaN(faceMatchScore) && faceMatchScore < 80) {
          result.riskSignals.flags.push('face_match_below_threshold');
        }
      }
    }

    const calculateMatchScore = (): number => {
      if (faceMatchScore !== null && !isNaN(faceMatchScore)) {
        return Math.round(faceMatchScore);
      }

      let score = 0;
      if (result.checks.documentValid === true) score += 40;
      if (result.checks.ocrMatch === true) score += 20;
      if (result.checks.liveness === 'pass') score += 20;
      if (result.checks.faceMatch === 'detected') score += 20;

      return Math.min(100, score);
    };

    const calculateRiskLevel = (): 'Low' | 'Medium' | 'High' => {
      const flags = result.riskSignals.flags || [];
      const flagCount = flags.length;

      if (flagCount === 0 && allChecksPassed) {
        return 'Low';
      }

      if (
        flagCount >= 2 ||
        flags.includes('face_match_below_threshold') ||
        flags.includes('behavioral_fraud')
      ) {
        return 'High';
      }

      return 'Medium';
    };

    const matchScore = calculateMatchScore();
    const riskLevel = calculateRiskLevel();

    const existingResult = await client.query(
      `SELECT verification_id FROM verification_ai_results WHERE verification_id = $1`,
      [verificationId]
    );

    if (existingResult.rows.length > 0) {
      await client.query(
        `UPDATE verification_ai_results 
         SET provider = $1, raw_response = $2, checks = $3, risk_signals = $4
         WHERE verification_id = $5`,
        [
          'gcp',
          JSON.stringify(result.rawResponse),
          JSON.stringify(result.checks),
          JSON.stringify(result.riskSignals),
          verificationId,
        ]
      );
    } else {
      await client.query(
        `INSERT INTO verification_ai_results 
         (verification_id, provider, raw_response, checks, risk_signals)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          verificationId,
          'gcp',
          JSON.stringify(result.rawResponse),
          JSON.stringify(result.checks),
          JSON.stringify(result.riskSignals),
        ]
      );
    }

    const finalStatus = allChecksPassed ? 'Completed' : 'Rejected';
    const flags = result.riskSignals.flags ?? [];
    let failureReason: string | null = null;
    if (finalStatus === 'Rejected') {
      if (flags.includes('document_expired')) failureReason = 'document_expired';
      else if (flags.includes('spoof_detected')) failureReason = 'document_spoof_detected';
      else if (flags.includes('behavioral_fraud')) failureReason = 'behavioral_fraud_detected';
      else if (flags.includes('document_validation_failed')) failureReason = 'document_not_clear';
      else if (flags.includes('liveness_check_failed')) failureReason = 'liveness_video_not_clear';
      else if (flags.includes('face_match_below_threshold')) failureReason = 'face_match_too_low';
      else failureReason = 'match_score_too_low';
    }

    const isAutoApproved = false; // Auto-approval disabled as per requirement

    await client.query(
      `UPDATE verifications 
       SET status = $1, 
           match_score = $2,
           risk_level = $3,
           failure_reason = $4,
           verified_at = NULL,
           is_auto_approved = $6,
           updated_at = NOW() 
       WHERE id = $5`,
      [finalStatus, matchScore, riskLevel, failureReason, verificationId, isAutoApproved]
    );

    await client.query('COMMIT');

    const orgId = verification.organization_id;
    // Send manual_review_required if Completed, verification_rejected if Rejected
    const event = finalStatus === 'Completed' ? 'manual_review_required' : 'verification_rejected';

    // Only send webhook if relevant
    if (event === 'manual_review_required' || event === 'verification_rejected') {
      deliverWebhook(orgId, event, {
        verificationId,
        verificationStatus: finalStatus,
        matchScore: matchScore ?? null,
        riskLevel: riskLevel ?? null,
        failureReason: failureReason ?? null,
        checks: result.checks,
        riskSignals: result.riskSignals,
      }).catch(() => { });
    }
  } catch (error: any) {
    await client.query('ROLLBACK');

    await client.query(
      `UPDATE verifications 
       SET status = $1, 
           match_score = 0,
           risk_level = 'High',
           updated_at = NOW() 
       WHERE id = $2`,
      ['Rejected', verificationId]
    );

    const orgResult = await client.query(
      `SELECT organization_id FROM verifications WHERE id = $1`,
      [verificationId]
    );
    if (orgResult.rows[0]?.organization_id) {
      deliverWebhook(orgResult.rows[0].organization_id, 'verification_rejected', {
        verificationId,
        verificationStatus: 'Rejected',
        matchScore: 0,
        riskLevel: 'High',
        failureReason: null,
      }).catch(() => { });
    }

    throw error;
  } finally {
    client.release();
  }
}

