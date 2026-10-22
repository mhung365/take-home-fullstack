import { ACKNOWLEDGE_FIELDS } from '../config/loader';
import { WorkflowError, validationError } from '../errors';
import type { AuditEntry, Claim } from '../model/types';
import { isEmpty, show } from '../rules/values';
import { isPlainObject } from '../util';

export interface CreateClaimInput {
  memberId: string;
  amount: number;
  policyLimit: number;
  /** Any other field must be in actions.createClaim.inputs; it is stored in data. */
  [field: string]: unknown;
}

export interface AcknowledgeResult {
  claim: Claim;
  /** The MEMBER_ACKNOWLEDGED entry, as stored. */
  audit: AuditEntry;
}

/** The core fields createClaim accepts; the engine sets the others. */
export const CREATE_CLAIM_FIELDS = ['memberId', 'amount', 'policyLimit'] as const;

export const CLAIM_CREATED_REASON = 'Claim created';
export const ACKNOWLEDGE_REASON = 'Member acknowledgement recorded';

type CreateClaimCore = Pick<Claim, (typeof CREATE_CLAIM_FIELDS)[number]>;

/** Throws INVALID_PAYLOAD for fields outside core + inputs, then VALIDATION_ERROR listing every bad core value. */
export function parseCreateInput(
  input: unknown,
  inputs: readonly string[],
): { core: CreateClaimCore; data: Record<string, unknown> } {
  const allowed = [...CREATE_CLAIM_FIELDS, ...inputs];
  if (!isPlainObject(input)) {
    throw validationError([{ field: '', message: `Claim input must be an object. Allowed: ${allowed.join(', ')}` }]);
  }

  const rejected = Object.keys(input).filter((field) => !allowed.includes(field));
  if (rejected.length > 0) {
    const subject = rejected.length === 1 ? `Field ${rejected[0]} is` : `Fields ${rejected.join(', ')} are`;
    throw new WorkflowError(
      'INVALID_PAYLOAD',
      `${subject} not accepted by action createClaim. Allowed: ${allowed.join(', ')}`,
      { action: 'createClaim', rejected, allowed },
    );
  }

  const errors: { field: string; message: string }[] = [];
  const { memberId, amount, policyLimit } = input;
  if (isEmpty(memberId)) errors.push({ field: 'memberId', message: 'memberId is required' });
  else if (typeof memberId !== 'string') {
    errors.push({ field: 'memberId', message: `memberId must be a string, got ${show(memberId)}` });
  }
  for (const [field, value] of [['amount', amount], ['policyLimit', policyLimit]] as const) {
    if (value === undefined || value === null) errors.push({ field, message: `${field} is required` });
    else if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      errors.push({ field, message: `${field} must be a positive number, got ${show(value)}` });
    }
  }
  if (errors.length > 0) throw validationError(errors);

  const data: Record<string, unknown> = {};
  for (const field of inputs) {
    if (Object.hasOwn(input, field)) data[field] = structuredClone(input[field]);
  }
  return {
    core: { memberId: memberId as string, amount: amount as number, policyLimit: policyLimit as number },
    data,
  };
}

export function acknowledgementFields(userId: string, at: string): Record<string, unknown> {
  return {
    [ACKNOWLEDGE_FIELDS.acknowledged]: true,
    [ACKNOWLEDGE_FIELDS.at]: at,
    [ACKNOWLEDGE_FIELDS.by]: userId,
  };
}

export function alreadyAcknowledged(claim: Claim): WorkflowError | null {
  const { data } = claim;
  if (data[ACKNOWLEDGE_FIELDS.acknowledged] !== true) return null;
  const at = data[ACKNOWLEDGE_FIELDS.at];
  const by = data[ACKNOWLEDGE_FIELDS.by];
  const text = (value: unknown) => (typeof value === 'string' ? value : show(value));
  return new WorkflowError(
    'ACTION_NOT_ALLOWED_IN_STATE',
    `Member acknowledgement already recorded at ${text(at)} by ${text(by)}`,
    { action: 'acknowledge', acknowledgedAt: at, acknowledgedBy: by },
  );
}
