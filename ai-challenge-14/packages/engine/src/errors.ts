import type { RuleFailure } from './rules/types';

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

export function unknownUser(userId: string): WorkflowError {
  return new WorkflowError('UNKNOWN_USER', `Unknown user ${userId}`, { userId });
}

export function staleClaim(claimId: string, version: number, expectedVersion: number): WorkflowError {
  return new WorkflowError(
    'STALE_CLAIM',
    `Claim ${claimId} was modified (version ${version}, expected ${expectedVersion}); reload and retry`,
    { claimId, version, expectedVersion },
  );
}

/** subject is e.g. "Transition approve" or "Action createClaim". */
export function unauthorizedRole(
  subject: string,
  requiredRoles: readonly string[],
  user: { id: string; role: string },
): WorkflowError {
  return new WorkflowError(
    'UNAUTHORIZED_ROLE',
    `${subject} requires role ${requiredRoles.join(' or ')}; user ${user.id} has role ${user.role}`,
    { requiredRoles: [...requiredRoles], userId: user.id, role: user.role },
  );
}

export function preconditionFailed(transitionId: string, failures: readonly RuleFailure[]): WorkflowError {
  return new WorkflowError('PRECONDITION_FAILED', failures.map((f) => f.message).join('; '), {
    transitionId,
    failures: [...failures],
  });
}

export function cycleLimitExceeded(transitionId: string, max: number, message: string): WorkflowError {
  return new WorkflowError('CYCLE_LIMIT_EXCEEDED', message, { transitionId, max });
}

export function actionNotAllowedInState(
  action: string,
  allowedStates: readonly string[],
  current: string,
): WorkflowError {
  return new WorkflowError(
    'ACTION_NOT_ALLOWED_IN_STATE',
    `Action ${action} is only allowed in states: ${allowedStates.join(', ')} (current: ${current})`,
    { action, allowedStates: [...allowedStates], current },
  );
}

export function validationError(errors: readonly { field: string; message: string }[]): WorkflowError {
  return new WorkflowError('VALIDATION_ERROR', errors.map((e) => e.message).join('; '), {
    errors: errors.map((e) => ({ ...e })),
  });
}
