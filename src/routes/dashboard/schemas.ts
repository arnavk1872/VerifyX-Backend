import { z } from 'zod';

export const decisionSchema = z.object({
  status: z.enum(['Approved', 'Rejected', 'Flagged']),
  reviewNotes: z.string().optional(),
  adminComment: z.string().optional(),
});

export const webhookConfigSchema = z.object({
  url: z.string().url(),
  events: z.object({
    verificationApproved: z.boolean().optional(),
    verificationRejected: z.boolean().optional(),
    manualReviewRequired: z.boolean().optional(),
    documentUploaded: z.boolean().optional(),
    verificationStarted: z.boolean().optional(),
  }).optional(),
});

export const updatePlanSchema = z.object({
  plan: z.enum(['free', 'pro', 'custom']),
});
