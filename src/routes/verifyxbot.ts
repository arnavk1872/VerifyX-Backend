import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { GoogleGenAI } from '@google/genai';

const VERIFYX_SYSTEM_PROMPT = `You are VerifyXbot, the AI assistant for VerifyX. Answer questions about VerifyX accurately and concisely using only the information below. If asked about something outside this scope, say you can only help with VerifyX.

About VerifyX:
- VerifyX is an AI-powered identity verification platform that enables businesses to onboard customers in seconds.
- We use automated OCR, 3D liveness detection, and direct government data integration to verify identities quickly and securely.
- Tagline: "Identity Verification at the Speed of AI."

Verification process:
- Users upload their identity document, complete a 3D liveness check.
- The system automatically extracts data using OCR, matches facial features, and verifies against government databases.
- The entire process takes less than 3 seconds on average.

Countries and documents:
- Currently supports India and Singapore.
- Document types: Aadhaar, PAN, NRIC, Passport, and more. Continuously expanding coverage.

Security and compliance:
- AES-256 encryption for data at rest, TLS/SSL for data in transit.
- GDPR compliant, SOC2 Type II certified, ISO 27001 certified.
- All biometric data is automatically purged after successful verification.

Accuracy:
- 99.1% accuracy rate through advanced AI algorithms, multiple verification checks, and continuous learning.

API and integration:
- Comprehensive REST API for integrating identity verification into applications.
- Webhooks for real-time verification status updates.

If verification fails:
- Cases are routed to manual review. Notification via webhook; team reviews within 24 hours. Custom fallback rules configurable in the dashboard.

Pricing:
- Free starter plan: up to 500 verifications per month.
- Professional: from $299/month for up to 5,000 verifications.
- Enterprise: custom pricing for unlimited verifications. All plans include core features and support.

Features:
- Multi-Country OCR: Multiple countries, local scripts and formats, 99% accuracy.
- 3D Liveness Detection: passive and active liveness, anti-spoofing AI.
- Direct Government Sync: UIDAI (India), AAMVA (USA), real-time validation, digital twin match.`;

const bodySchema = z.object({
  message: z.string().min(1).max(4000),
  history: z
    .array(
      z.object({
        role: z.enum(['user', 'model']),
        content: z.string(),
      })
    )
    .optional()
    .default([]),
});

export async function verifyxbotRoutes(fastify: FastifyInstance) {
  fastify.post(
    '/api/verifyxbot',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = bodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid request body', details: parsed.error.flatten() });
      }
      const { message, history } = parsed.data;

      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        fastify.log.error('GEMINI_API_KEY is not set');
        return reply.code(503).send({
          error: 'VerifyXbot is not configured. Set GEMINI_API_KEY in the backend .env (get a key at aistudio.google.com/apikey).',
        });
      }

      try {
        const ai = new GoogleGenAI({ apiKey });
        const contents: { role: 'user' | 'model'; parts: { text: string }[] }[] = [
          ...history.map((h) => ({
            role: (h.role === 'model' ? 'model' : 'user') as 'user' | 'model',
            parts: [{ text: h.content }],
          })),
          { role: 'user' as const, parts: [{ text: message }] },
        ];

        const stream = await ai.models.generateContentStream({
          model: 'gemini-2.0-flash',
          contents,
          config: { systemInstruction: VERIFYX_SYSTEM_PROMPT },
        });

        (reply as { sent?: boolean }).sent = true;
        reply.raw.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'Access-Control-Allow-Origin': request.headers.origin ?? '*',
        });

        for await (const chunk of stream) {
          const text = chunk.text ?? '';
          if (text) reply.raw.write(`data: ${JSON.stringify({ text })}\n\n`);
        }
        reply.raw.write('data: [DONE]\n\n');
        reply.raw.end();
      } catch (err) {
        fastify.log.error(err);
        return reply.code(500).send({ error: 'Failed to get response from VerifyXbot' });
      }
    }
  );
}
