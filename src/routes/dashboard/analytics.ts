import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { pool } from '../../db/pool';
import { requireAuth } from '../../middleware/role-guard';

export async function registerAnalyticsRoutes(fastify: FastifyInstance) {
  fastify.get('/api/dashboard/analytics', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = requireAuth(request, reply);
    if (!user) return;

    try {
      const q = request.query as { range?: string; startDate?: string; endDate?: string };
      let startDate: string;
      let endDate: string;
      const now = new Date();
      const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      end.setUTCHours(23, 59, 59, 999);
      if (q.startDate && q.endDate) {
        startDate = q.startDate;
        endDate = q.endDate;
      } else {
        const range = q.range || '30d';
        const days = range === '7d' ? 7 : range === '90d' ? 90 : 30;
        const start = new Date(end);
        start.setDate(start.getDate() - days);
        start.setUTCHours(0, 0, 0, 0);
        startDate = start.toISOString().slice(0, 10);
        endDate = end.toISOString().slice(0, 10);
      }
      const orgId = user.organizationId;
      const client = await pool.connect();
      try {
        const rangeStart = `${startDate}T00:00:00.000Z`;
        const rangeEnd = `${endDate}T23:59:59.999Z`;
        const prevDays = Math.ceil((new Date(rangeEnd).getTime() - new Date(rangeStart).getTime()) / (24 * 60 * 60 * 1000));
        const prevEnd = new Date(new Date(rangeStart).getTime() - 1);
        const prevStart = new Date(prevEnd.getTime() - prevDays * 24 * 60 * 60 * 1000);
        const prevStartStr = prevStart.toISOString().slice(0, 10) + 'T00:00:00.000Z';
        const prevEndStr = prevEnd.toISOString();

        const kpiResult = await client.query(
          `WITH curr AS (
            SELECT
              COUNT(*) FILTER (WHERE status IN ('completed','failed')) as terminal_count,
              COUNT(*) FILTER (WHERE status = 'completed') as completed_count,
              COUNT(*) FILTER (WHERE is_auto_approved = true AND status = 'completed') as auto_count,
              COUNT(*) as total_count,
              AVG(EXTRACT(EPOCH FROM (verified_at - created_at))) FILTER (WHERE status IN ('completed','failed') AND verified_at IS NOT NULL) as avg_seconds,
              AVG(match_score) FILTER (WHERE status = 'completed' AND match_score IS NOT NULL) as avg_match
            FROM verifications WHERE organization_id = $1 AND created_at >= $2::timestamptz AND created_at <= $3::timestamptz
          ), prev AS (
            SELECT
              COUNT(*) FILTER (WHERE status IN ('completed','failed')) as prev_terminal_count,
              COUNT(*) FILTER (WHERE status = 'completed') as prev_completed_count,
              COUNT(*) FILTER (WHERE is_auto_approved = true AND status = 'completed') as prev_auto_count,
              COUNT(*) as prev_total_count,
              AVG(EXTRACT(EPOCH FROM (verified_at - created_at))) FILTER (WHERE status IN ('completed','failed') AND verified_at IS NOT NULL) as prev_avg_seconds,
              AVG(match_score) FILTER (WHERE status = 'completed' AND match_score IS NOT NULL) as prev_avg_match
            FROM verifications WHERE organization_id = $1 AND created_at >= $4::timestamptz AND created_at <= $5::timestamptz
          )
          SELECT curr.*, prev.* FROM curr, prev`,
          [orgId, rangeStart, rangeEnd, prevStartStr, prevEndStr]
        );
        const k = kpiResult.rows[0];
        const currTotal = parseInt(k?.total_count || '0', 10);
        const currTerminal = parseInt(k?.terminal_count || '0', 10);
        const currCompleted = parseInt(k?.completed_count || '0', 10);
        const currAuto = parseInt(k?.auto_count || '0', 10);
        const currAvgSec = k?.avg_seconds != null ? parseFloat(k.avg_seconds) : null;
        const currAvgMatch = k?.avg_match != null ? parseFloat(k.avg_match) : null;
        const prevTotal = parseInt(k?.prev_total_count || '0', 10);
        const prevTerminal = parseInt(k?.prev_terminal_count || '0', 10);
        const prevCompleted = parseInt(k?.prev_completed_count || '0', 10);
        const prevAuto = parseInt(k?.prev_auto_count || '0', 10);
        const prevAvgSec = k?.prev_avg_seconds != null ? parseFloat(k.prev_avg_seconds) : null;
        const prevAvgMatch = k?.prev_avg_match != null ? parseFloat(k.prev_avg_match) : null;

        const avgProcessingSec = currAvgSec != null ? Math.round(currAvgSec) : 0;
        const prevAvgProcessingSec = prevAvgSec != null ? Math.round(prevAvgSec) : 0;
        const processingChange = prevAvgProcessingSec > 0 ? Math.round(((prevAvgProcessingSec - avgProcessingSec) / prevAvgProcessingSec) * 100) : 0;
        const automationPct = currCompleted > 0 ? Math.round((currAuto / currCompleted) * 1000) / 10 : 0;
        const prevAutomationPct = prevCompleted > 0 ? Math.round((prevAuto / prevCompleted) * 1000) / 10 : 0;
        const automationChange = prevAutomationPct > 0 ? Math.round((automationPct - prevAutomationPct) * 10) / 10 : 0;
        const abandoned = currTotal > 0 ? currTotal - currTerminal : 0;
        const abandonmentPct = currTotal > 0 ? Math.round((abandoned / currTotal) * 1000) / 10 : 0;
        const prevAbandoned = prevTotal > 0 ? prevTotal - prevTerminal : 0;
        const prevAbandonmentPct = prevTotal > 0 ? Math.round((prevAbandoned / prevTotal) * 1000) / 10 : 0;
        const abandonmentChange = prevAbandonmentPct > 0 ? Math.round((abandonmentPct - prevAbandonmentPct) * 10) / 10 : 0;
        const faceMatchPct = currCompleted > 0 && currAvgMatch != null ? Math.round(currAvgMatch) : 0;
        const prevFaceMatchPct = prevCompleted > 0 && prevAvgMatch != null ? Math.round(prevAvgMatch) : 0;
        const faceMatchChange = prevFaceMatchPct > 0 ? Math.round((faceMatchPct - prevFaceMatchPct) * 10) / 10 : 0;

        const volumeResult = await client.query(
          `SELECT date_trunc('day', created_at AT TIME ZONE 'UTC')::date as day,
            COUNT(*) FILTER (WHERE status = 'completed') as success,
            COUNT(*) FILTER (WHERE status = 'failed') as failed
          FROM verifications
          WHERE organization_id = $1 AND created_at >= $2::timestamptz AND created_at <= $3::timestamptz
          GROUP BY 1 ORDER BY 1`,
          [orgId, rangeStart, rangeEnd]
        );
        const volumeData = volumeResult.rows.map((r: any) => ({
          date: new Date(r.day).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
          Success: parseInt(r.success, 10),
          Failed: parseInt(r.failed, 10),
        }));

        const funnelResult = await client.query(
          `SELECT
            COUNT(*) as total,
            COUNT(*) FILTER (WHERE status IN ('documents_uploaded','liveness_uploaded','processing','completed','failed')) as id_upload,
            COUNT(*) FILTER (WHERE status IN ('liveness_uploaded','processing','completed','failed')) as liveness,
            COUNT(*) FILTER (WHERE status IN ('completed','failed')) as completion
          FROM verifications
          WHERE organization_id = $1 AND created_at >= $2::timestamptz AND created_at <= $3::timestamptz`,
          [orgId, rangeStart, rangeEnd]
        );
        const fr = funnelResult.rows[0];
        const total = parseInt(fr?.total || '0', 10);
        const idUpload = total > 0 ? Math.round((parseInt(fr?.id_upload || '0', 10) / total) * 100) : 0;
        const liveness = total > 0 ? Math.round((parseInt(fr?.liveness || '0', 10) / total) * 100) : 0;
        const completion = total > 0 ? Math.round((parseInt(fr?.completion || '0', 10) / total) * 100) : 0;
        const drops = [100 - idUpload, idUpload - liveness, liveness - completion];
        const maxDropIdx = drops.indexOf(Math.max(...drops));
        const funnelSteps = [
          { step: 'Registration', value: 100, change: 0, highestDropoff: false },
          { step: 'ID Upload', value: idUpload, change: 0, highestDropoff: maxDropIdx === 0 },
          { step: 'Facial Liveness', value: liveness, change: 0, highestDropoff: maxDropIdx === 1 },
          { step: 'Completion', value: completion, change: 0, highestDropoff: maxDropIdx === 2 },
        ];

        const rejectionResult = await client.query(
          `SELECT failure_reason, COUNT(*) as cnt
          FROM verifications
          WHERE organization_id = $1 AND status = 'failed' AND created_at >= $2::timestamptz AND created_at <= $3::timestamptz
          GROUP BY failure_reason`,
          [orgId, rangeStart, rangeEnd]
        );
        const reasonLabels: Record<string, { name: string; color: string }> = {
          document_not_clear: { name: 'Blurry Image', color: '#EF4444' },
          face_match_too_low: { name: 'Face Mismatch', color: '#EA580C' },
          liveness_video_not_clear: { name: 'Liveness Failed', color: '#F97316' },
          match_score_too_low: { name: 'Match Score Low', color: '#DC2626' },
        };
        const totalFailed = rejectionResult.rows.reduce((sum: number, r: any) => sum + parseInt(r.cnt, 10), 0);
        const byLabel: Record<string, { count: number; color: string }> = {};
        const otherRawReasons: string[] = [];
        for (const r of rejectionResult.rows) {
          const raw = (r.failure_reason || '').trim();
          const key = raw || 'other';
          const { name, color } = reasonLabels[key] || { name: 'Other', color: '#6B7280' };
          if (!byLabel[name]) byLabel[name] = { count: 0, color };
          byLabel[name].count += parseInt(r.cnt, 10);
          if (name === 'Other' && raw) {
            if (!otherRawReasons.includes(raw)) otherRawReasons.push(raw);
          }
        }
        const rejectionData = Object.entries(byLabel).map(([name, { count, color }]) => ({
          name,
          value: totalFailed > 0 ? Math.round((count / totalFailed) * 100) : 0,
          color,
        }));

        return reply.send({
          kpis: {
            averageProcessingTimeSeconds: avgProcessingSec,
            processingTimeChangePercent: processingChange,
            processingTimeGoal: 30,
            automationRatePercent: automationPct,
            automationRateChangePercent: automationChange,
            automationRateGoal: 95,
            abandonmentRatePercent: abandonmentPct,
            abandonmentRateChangePercent: abandonmentChange,
            abandonmentRateGoal: 10,
            faceMatchAccuracyPercent: faceMatchPct,
            faceMatchAccuracyChangePercent: faceMatchChange,
            faceMatchAccuracyGoal: 99,
          },
          volume: volumeData,
          funnel: funnelSteps,
          rejectionReasons: rejectionData,
          otherRejectionReasons: otherRawReasons,
        });
      } finally {
        client.release();
      }
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });
}
