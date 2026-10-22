import { z } from 'zod';

const expectedVersion = z.number().int().positive().optional();
const notes = z.string().optional();

/** Only the shape: field-level checks (core fields, createClaim.inputs) belong to the engine. */
export const createClaimBody = z.record(z.string(), z.unknown());

export const transitionBody = z.strictObject({
  to: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).optional(),
  notes,
  expectedVersion,
});

export const acknowledgeBody = z.strictObject({ notes, expectedVersion });

export const listClaimsQuery = z.strictObject({
  /** Comma-separated state ids. */
  status: z
    .string()
    .optional()
    .transform((s) => s?.split(',').map((v) => v.trim()).filter(Boolean)),
});

export const advanceClockBody = z.strictObject({
  days: z.number().positive().max(3650),
});
