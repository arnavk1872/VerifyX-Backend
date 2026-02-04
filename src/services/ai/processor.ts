import { pool } from '../../db/pool';
import { deliverWebhook } from '../webhooks/deliver';
import { compareFaces, detectFaces } from '../gcp/vision';
import { detectFacesInVideo } from '../gcp/video-liveness';
import { extractAndParseDocument } from '../../ocr/document-parser';
import type { DocumentType } from '../../ocr/document-parser';

export interface ProcessingResult {
  checks: {
    liveness?: 'pass' | 'fail' | 'unknown';
    faceMatch?: string;
    documentValid?: boolean;
    ocrMatch?: boolean;
  };
  riskSignals: {
    verified?: boolean;
    suspiciousPatterns?: string[];
    flags?: string[];
  };
  rawResponse: Record<string, any>;
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

    const result: ProcessingResult = {
      checks: {},
      riskSignals: {},
      rawResponse: {},
    };

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
          },
          rawText: parsedDoc.extractedFields?.rawText || null,
          extractedFields: parsedDoc.extractedFields || {},
        };

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

    const faceMatchScore = result.checks.faceMatch 
      ? (result.checks.faceMatch === 'detected' ? 100 : parseFloat(result.checks.faceMatch.replace('%', '')))
      : null;
    
    const allChecksPassed = 
      result.checks.documentValid === true &&
      result.checks.liveness === 'pass' &&
      (faceMatchScore === null || faceMatchScore >= 80 || faceMatchScore === 100);

    result.riskSignals.verified = allChecksPassed;
    
    if (!allChecksPassed) {
      result.riskSignals.flags = [];
      if (result.checks.documentValid === false) {
        result.riskSignals.flags.push('document_validation_failed');
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
      
      if (flagCount >= 2 || flags.includes('face_match_below_threshold')) {
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

    const finalStatus = allChecksPassed ? 'completed' : 'failed';
    const flags = result.riskSignals.flags ?? [];
    let failureReason: string | null = null;
    if (finalStatus === 'failed') {
      if (flags.includes('document_validation_failed')) failureReason = 'document_not_clear';
      else if (flags.includes('liveness_check_failed')) failureReason = 'liveness_video_not_clear';
      else if (flags.includes('face_match_below_threshold')) failureReason = 'face_match_too_low';
      else failureReason = 'match_score_too_low';
    }

    const isAutoApproved = finalStatus === 'completed';

    await client.query(
      `UPDATE verifications 
       SET status = $1, 
           match_score = $2,
           risk_level = $3,
           failure_reason = $4,
           verified_at = NOW(),
           is_auto_approved = $6,
           updated_at = NOW() 
       WHERE id = $5`,
      [finalStatus, matchScore, riskLevel, failureReason, verificationId, isAutoApproved]
    );

    await client.query('COMMIT');

    const orgId = verification.organization_id;
    const event = finalStatus === 'completed' ? 'verification_approved' : 'verification_rejected';
    deliverWebhook(orgId, event, {
      verificationId,
      verificationStatus: finalStatus === 'completed' ? 'Approved' : 'Rejected',
      matchScore: matchScore ?? null,
      riskLevel: riskLevel ?? null,
      failureReason: failureReason ?? null,
    }).catch(() => {});
  } catch (error: any) {
    await client.query('ROLLBACK');

    await client.query(
      `UPDATE verifications 
       SET status = $1, 
           match_score = 0,
           risk_level = 'High',
           updated_at = NOW() 
       WHERE id = $2`,
      ['failed', verificationId]
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
      }).catch(() => {});
    }

    throw error;
  } finally {
    client.release();
  }
}

