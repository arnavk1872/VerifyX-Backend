import { pool } from '../../db/pool';
import { deliverWebhook } from '../webhooks/deliver';
import { detectFaces } from '../gcp/vision';
import { detectFacesInVideo } from '../gcp/video-liveness';
import { compareFaces as compareFacesRekognition } from '../aws/rekognition';
import { extractSingleLivenessFrame } from '../media/liveness-thumbnails';
import { extractDocumentFields } from '../../ocr/extract-document-fields';
import type { DocumentType, ParsedDocument } from '../../ocr/document-parser';
import { runDocumentFraudDetection } from '../gcp/document-ai';
import { analyzeSpoofSignalsForImages } from './spoof-detection';
import { calculateBehavioralRisk } from '../risk/behavioral-scoring';
import { runValidationRules } from '../../validation-engine/validation-engine';
import { validationRules } from '../../validation-engine/rule-registry';
import { config } from '../../config';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { s3Client } from '../aws/s3';
import {
  validateTemplateLayout,
  validateTampering,
  validateImageQuality,
  validateOcrFields,
  validateFieldConsistency,
  validateCrossFieldConsistency,
  validateMrzChecksum,
} from '../validation';

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

const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME;

async function downloadDocumentFromS3(s3Key: string): Promise<Buffer> {
  if (!S3_BUCKET_NAME) throw new Error('S3_BUCKET_NAME is required');
  const command = new GetObjectCommand({ Bucket: S3_BUCKET_NAME, Key: s3Key });
  const response = await s3Client.send(command);
  if (!response.Body) throw new Error('Failed to download from S3');
  const chunks: Uint8Array[] = [];
  for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
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
        templateMatchingEnabled?: boolean;
        tamperingDetectionEnabled?: boolean;
        ocrValidationEnabled?: boolean;
        fieldConsistencyEnabled?: boolean;
        crossFieldConsistencyEnabled?: boolean;
        mrzChecksumEnabled?: boolean;
        imageQualityEnabled?: boolean;
      }) || {};
    const verificationRules = {
      documentExpiryCheckEnabled: rawRules.documentExpiryCheckEnabled === true,
      ghostSpoofCheckEnabled: rawRules.ghostSpoofCheckEnabled === true,
      behavioralFraudCheckEnabled: rawRules.behavioralFraudCheckEnabled === true,
      templateMatchingEnabled: rawRules.templateMatchingEnabled !== false,
      tamperingDetectionEnabled: rawRules.tamperingDetectionEnabled !== false,
      ocrValidationEnabled: rawRules.ocrValidationEnabled !== false,
      fieldConsistencyEnabled: rawRules.fieldConsistencyEnabled !== false,
      crossFieldConsistencyEnabled: rawRules.crossFieldConsistencyEnabled !== false,
      mrzChecksumEnabled: rawRules.mrzChecksumEnabled !== false,
      imageQualityEnabled: rawRules.imageQualityEnabled !== false,
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
    const faceMatchThreshold = config.FACE_MATCH_THRESHOLD;

    let parsedDoc: ParsedDocument | null = null;
    if (documentS3Key) {
      try {
        parsedDoc = await extractDocumentFields({
          s3Key: documentS3Key,
          documentType: verification.id_type as DocumentType,
        });

        result.checks.documentValid = !!(parsedDoc.fullName && parsedDoc.idNumber);
        result.checks.ocrMatch = !!(parsedDoc.fullName && parsedDoc.idNumber);
        const ef = parsedDoc.extractedFields || {};
        result.rawResponse.ocr = {
          extracted: {
            fullName: parsedDoc.fullName || null,
            idNumber: parsedDoc.idNumber || null,
            dob: (ef.dobDisplay as string) || parsedDoc.dob || null,
            address: parsedDoc.address || null,
            documentExpiryDate: (ef.expiryDateDisplay as string) || parsedDoc.expiryDate || null,
          },
          rawText: ef.rawText || null,
          extractedFields: ef,
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
            `SELECT verification_id, confirmed_at FROM verification_pii WHERE verification_id = $1`,
            [verificationId]
          );

          const hasUserConfirmation = existingPii.rows[0]?.confirmed_at != null;

          if (existingPii.rows.length > 0 && !hasUserConfirmation) {
            await client.query(
              `UPDATE verification_pii SET full_name = $1 WHERE verification_id = $2`,
              [parsedDoc.fullName, verificationId]
            );
          } else if (existingPii.rows.length === 0) {
            await client.query(
              `INSERT INTO verification_pii (verification_id, full_name) VALUES ($1, $2)`,
              [verificationId, parsedDoc.fullName]
            );
          }
          // If user already confirmed details, do NOT overwrite with OCR extraction
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

      try {
        const fraudResult = await runDocumentFraudDetection(documentS3Key);
        if (fraudResult) {
          result.rawResponse.fraudDetection = fraudResult;
        }
      } catch (_) {
        // Fraud detection is optional; do not fail verification
      }

      const needDocumentBuffer =
        verificationRules.templateMatchingEnabled ||
        verificationRules.tamperingDetectionEnabled ||
        verificationRules.imageQualityEnabled;
      let documentBuffer: Buffer | null = null;
      if (needDocumentBuffer && S3_BUCKET_NAME) {
        try {
          documentBuffer = await downloadDocumentFromS3(documentS3Key);
        } catch (e) {
          // Non-blocking; leave checks unset or skip
        }
      }

      if (verificationRules.templateMatchingEnabled && documentBuffer) {
        try {
          const sharp = await import('sharp');
          const meta = await sharp.default(documentBuffer).metadata();
          const dimensions = meta.width != null && meta.height != null ? { width: meta.width, height: meta.height } : null;
          const templateResult = validateTemplateLayout(dimensions);
          result.checks.templateMatching = templateResult.passed ? 'pass' : 'fail';
          if (templateResult.detail) result.rawResponse.templateMatchingDetail = templateResult.detail;
        } catch {
          result.checks.templateMatching = 'pass';
        }
      }
      if (verificationRules.tamperingDetectionEnabled && documentBuffer) {
        try {
          const tamperingResult = await validateTampering(documentBuffer);
          result.checks.tamperingDetection = tamperingResult.passed ? 'pass' : 'fail';
          if (tamperingResult.detail) result.rawResponse.tamperingDetectionDetail = tamperingResult.detail;
        } catch {
          result.checks.tamperingDetection = 'pass';
        }
      }
      if (verificationRules.imageQualityEnabled && documentBuffer) {
        try {
          const qualityResult = await validateImageQuality(documentBuffer);
          result.checks.imageQuality = qualityResult.passed ? 'pass' : 'fail';
          if (qualityResult.detail) result.rawResponse.imageQualityDetail = qualityResult.detail;
        } catch {
          result.checks.imageQuality = 'pass';
        }
      }
      if (verificationRules.ocrValidationEnabled && parsedDoc) {
        try {
          const ocrResult = validateOcrFields(parsedDoc);
          result.checks.ocrValidation = ocrResult.passed ? 'pass' : 'fail';
          if (ocrResult.detail) result.rawResponse.ocrValidationDetail = ocrResult.detail;
        } catch {
          result.checks.ocrValidation = 'pass';
        }
      }
      if (verificationRules.fieldConsistencyEnabled && parsedDoc) {
        try {
          const fcResult = validateFieldConsistency(parsedDoc);
          result.checks.fieldConsistency = fcResult.passed ? 'pass' : 'fail';
          if (fcResult.detail) result.rawResponse.fieldConsistencyDetail = fcResult.detail;
        } catch {
          result.checks.fieldConsistency = 'pass';
        }
      }
      if (verificationRules.crossFieldConsistencyEnabled && parsedDoc) {
        try {
          const mrzData = parsedDoc.extractedFields?.mrz ? { fullName: parsedDoc.extractedFields.mrzFullName as string, idNumber: parsedDoc.extractedFields.mrzIdNumber as string } : undefined;
          const xfResult = validateCrossFieldConsistency(parsedDoc, mrzData);
          result.checks.crossFieldConsistency = xfResult.passed ? 'pass' : 'fail';
          if (xfResult.detail) result.rawResponse.crossFieldConsistencyDetail = xfResult.detail;
        } catch {
          result.checks.crossFieldConsistency = 'pass';
        }
      }
      if (verificationRules.mrzChecksumEnabled) {
        try {
          const mrzLine = parsedDoc?.extractedFields?.mrzLine as string | undefined;
          const mrzResult = validateMrzChecksum(mrzLine);
          result.checks.mrzChecksum = mrzResult.passed ? 'pass' : 'fail';
          if (mrzResult.detail) result.rawResponse.mrzChecksumDetail = mrzResult.detail;
        } catch {
          result.checks.mrzChecksum = 'pass';
        }
      }
    }

    if (documentS3Key && livenessS3Key) {
      try {
        const livenessType = documentImages.liveness?.type;

        if (livenessType === 'video') {
          const videoFaces = await detectFacesInVideo(livenessS3Key);
          const livenessPassed = videoFaces.facePresent && videoFaces.movementDetected;
          result.checks.liveness = livenessPassed ? 'pass' : 'fail';
          result.rawResponse.liveness = {
            type: 'video',
            facePresent: videoFaces.facePresent,
            movementDetected: videoFaces.movementDetected,
            faceCount: videoFaces.faceCount,
          };

          if (videoFaces.facePresent && livenessPassed) {
            // Resolve a frame from thumbnails if available; otherwise extract one
            let frameS3Key: string | undefined;
            const frameKeys = Object.keys(documentImages)
              .filter((key: string) => key.startsWith('liveness_frame_'))
              .sort();
            const firstFrameKey = frameKeys[0];
            if (firstFrameKey && (documentImages[firstFrameKey] as { s3Key?: string })?.s3Key) {
              frameS3Key = (documentImages[firstFrameKey] as { s3Key: string }).s3Key;
            }

            if (!frameS3Key) {
              frameS3Key = await extractSingleLivenessFrame(
                livenessS3Key,
                verification.organization_id,
                verificationId
              );
            }

            try {
              const faceMatch = await compareFacesRekognition(
                documentS3Key,
                frameS3Key,
                faceMatchThreshold
              );
              result.checks.faceMatch = `${Math.round(faceMatch.similarity)}%`;
              result.rawResponse.faceMatch = {
                similarity: faceMatch.similarity,
                isMatch: faceMatch.isMatch,
                confidence: faceMatch.confidence,
                type: 'document_and_video',
              };
              if (!faceMatch.isMatch) {
                result.checks.liveness = 'fail';
              }
            } catch (error: any) {
              result.checks.faceMatch = '0%';
              result.checks.liveness = 'fail';
              result.rawResponse.faceMatchError =
                error instanceof Error ? error.message : 'Face comparison failed';
            }
          }
        } else {
          const faceMatch = await compareFacesRekognition(
            documentS3Key,
            livenessS3Key,
            faceMatchThreshold
          );
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
      ? (result.checks.faceMatch === 'detected'
          ? null
          : parseFloat(result.checks.faceMatch.replace('%', '')))
      : null;

    runValidationRules(
      { verificationId, videoKey: livenessS3Key ?? undefined },
      validationRules
    ).catch(() => {});

    const allChecksPassed =
      result.checks.documentValid === true &&
      result.checks.liveness === 'pass' &&
      (faceMatchScore === null ||
        faceMatchScore >= faceMatchThreshold ||
        faceMatchScore === 100) &&
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
        if (!isNaN(faceMatchScore) && faceMatchScore < faceMatchThreshold) {
          result.riskSignals.flags.push('face_match_below_threshold');
        }
      }
    }

    const INFORMATIONAL_CHECK_DEDUCTION = 3;
    const failedInformationalChecks = [
      result.checks.templateMatching,
      result.checks.tamperingDetection,
      result.checks.ocrValidation,
      result.checks.fieldConsistency,
      result.checks.crossFieldConsistency,
      result.checks.mrzChecksum,
      result.checks.imageQuality,
    ].filter((v) => v === 'fail').length;

    const calculateMatchScore = (): number => {
      if (faceMatchScore !== null && !isNaN(faceMatchScore)) {
        const base = Math.round(faceMatchScore);
        const afterDeduction = Math.max(0, base - failedInformationalChecks * INFORMATIONAL_CHECK_DEDUCTION);
        return Math.min(100, afterDeduction);
      }

      let score = 0;
      if (result.checks.documentValid === true) score += 40;
      if (result.checks.ocrMatch === true) score += 20;
      if (result.checks.liveness === 'pass') score += 20;
      if (result.checks.faceMatch && result.checks.faceMatch !== 'detected') {
        const pct = parseFloat(result.checks.faceMatch.replace('%', ''));
        if (!isNaN(pct)) score += Math.min(20, Math.round((pct / 100) * 20));
      }
      score = Math.max(0, score - failedInformationalChecks * INFORMATIONAL_CHECK_DEDUCTION);
      return Math.min(100, score);
    };

    const calculateRiskLevel = (): 'Low' | 'Medium' | 'High' => {
      const flags = result.riskSignals.flags || [];
      const flagCount = flags.length;

      if (flagCount === 0 && allChecksPassed && failedInformationalChecks === 0) {
        return 'Low';
      }

      if (
        flagCount >= 2 ||
        flags.includes('face_match_below_threshold') ||
        flags.includes('behavioral_fraud')
      ) {
        return 'High';
      }

      if (failedInformationalChecks >= 2) {
        return 'Medium';
      }

      return 'Medium';
    };

    const matchScore = calculateMatchScore();
    const riskLevel = calculateRiskLevel();

    await client.query(
      `INSERT INTO verification_ai_results 
       (verification_id, provider, raw_response, checks, risk_signals)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (verification_id) DO UPDATE SET
         provider = EXCLUDED.provider,
         raw_response = EXCLUDED.raw_response,
         checks = EXCLUDED.checks,
         risk_signals = EXCLUDED.risk_signals`,
      [
        verificationId,
        'gcp',
        JSON.stringify(result.rawResponse),
        JSON.stringify(result.checks),
        JSON.stringify(result.riskSignals),
      ]
    );

    const finalStatus = allChecksPassed ? 'Completed' : 'Rejected';
    const flags = result.riskSignals.flags ?? [];
    let failureReason: string | null = null;
    // Prefer specific reason: face match failure shows "face didn't match", not "liveness failed"
    if (finalStatus === 'Rejected') {
      if (flags.includes('document_expired')) failureReason = 'document_expired';
      else if (flags.includes('spoof_detected')) failureReason = 'document_spoof_detected';
      else if (flags.includes('behavioral_fraud')) failureReason = 'behavioral_fraud_detected';
      else if (flags.includes('document_validation_failed')) failureReason = 'document_not_clear';
      else if (flags.includes('face_match_below_threshold')) failureReason = 'face_match_too_low';
      else if (flags.includes('liveness_check_failed')) failureReason = 'liveness_video_not_clear';
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

