export const ERROR_CODES = [
  'CLAIM_NOT_FOUND',
  'UNKNOWN_USER',
  'INVALID_TRANSITION',
  'UNAUTHORIZED_ROLE',
  'INVALID_PAYLOAD',
  'PRECONDITION_FAILED',
  'CYCLE_LIMIT_EXCEEDED',
  'ACTION_NOT_ALLOWED_IN_STATE',
  'VALIDATION_ERROR',
  'STALE_CLAIM',
  'CLAIM_BUSY',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Expected business error. The API maps code to an HTTP status; anything else is a 500. */
export class WorkflowError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'WorkflowError';
  }

  toJSON(): { code: ErrorCode; message: string; details?: Record<string, unknown> } {
    return { code: this.code, message: this.message, details: this.details };
  }
}

export function isWorkflowError(error: unknown, code?: ErrorCode): error is WorkflowError {
  return error instanceof WorkflowError && (code === undefined || error.code === code);
}

export function claimNotFound(claimId: string): WorkflowError {
  return new WorkflowError('CLAIM_NOT_FOUND', `Claim ${claimId} not found`, { claimId });
}

export function claimBusy(claimId: string): WorkflowError {
  return new WorkflowError(
    'CLAIM_BUSY',
    `Claim ${claimId} is being modified by another request; retry later`,
    { claimId },
  );
}
