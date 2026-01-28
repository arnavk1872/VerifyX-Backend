UPDATE verifications v
SET 
  match_score = CASE
    WHEN ai.checks->>'faceMatch' = 'detected' THEN 100
    WHEN ai.checks->>'faceMatch' IS NOT NULL 
         AND ai.checks->>'faceMatch' != 'detected' 
         AND ai.checks->>'faceMatch' != 'unknown'
         AND ai.checks->>'faceMatch' ~ '^[0-9]+%?$' THEN
      LEAST(100, GREATEST(0, CAST(REGEXP_REPLACE(ai.checks->>'faceMatch', '[^0-9]', '', 'g') AS INTEGER)))
    ELSE
      CASE WHEN (ai.checks->>'documentValid')::boolean = true THEN 40 ELSE 0 END +
      CASE WHEN (ai.checks->>'ocrMatch')::boolean = true THEN 20 ELSE 0 END +
      CASE WHEN ai.checks->>'liveness' = 'pass' THEN 20 ELSE 0 END +
      CASE WHEN ai.checks->>'faceMatch' = 'detected' THEN 20 ELSE 0 END
  END,
  risk_level = CASE
    WHEN ai.risk_signals->>'verified' = 'true' AND (ai.risk_signals->'flags' IS NULL OR jsonb_array_length(ai.risk_signals->'flags') = 0) THEN 'Low'
    WHEN ai.risk_signals->'flags' IS NOT NULL AND (
      jsonb_array_length(ai.risk_signals->'flags') >= 2 OR
      EXISTS (SELECT 1 FROM jsonb_array_elements_text(ai.risk_signals->'flags') AS flag WHERE flag = 'face_match_below_threshold')
    ) THEN 'High'
    ELSE 'Medium'
  END
FROM verification_ai_results ai
WHERE v.id = ai.verification_id
  AND (v.match_score IS NULL OR v.risk_level IS NULL)
  AND ai.checks IS NOT NULL;
