import { Catch, HttpException, HttpStatus, Logger, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { isWorkflowError, type ErrorCode } from '@claims/engine';
import type { Response } from 'express';

const STATUS_BY_CODE: Record<ErrorCode, HttpStatus> = {
  CLAIM_NOT_FOUND: HttpStatus.NOT_FOUND,
  UNKNOWN_USER: HttpStatus.UNAUTHORIZED,
  INVALID_TRANSITION: HttpStatus.CONFLICT,
  UNAUTHORIZED_ROLE: HttpStatus.FORBIDDEN,
  INVALID_PAYLOAD: HttpStatus.BAD_REQUEST,
  PRECONDITION_FAILED: HttpStatus.UNPROCESSABLE_ENTITY,
  CYCLE_LIMIT_EXCEEDED: HttpStatus.UNPROCESSABLE_ENTITY,
  ACTION_NOT_ALLOWED_IN_STATE: HttpStatus.CONFLICT,
  VALIDATION_ERROR: HttpStatus.BAD_REQUEST,
  STALE_CLAIM: HttpStatus.CONFLICT,
  CLAIM_BUSY: HttpStatus.CONFLICT,
};

export interface ErrorBody {
  code: string;
  message: string;
  details: Record<string, unknown> | null;
}

/**
 * WorkflowError maps to its status (DESIGN 7). Nest HttpExceptions (unknown route, malformed
 * body) keep their status. Anything else is a 500 whose cause is only logged server-side.
 */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(ErrorFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const { status, body } = this.toResponse(exception);
    host.switchToHttp().getResponse<Response>().status(status).json(body);
  }

  private toResponse(exception: unknown): { status: number; body: ErrorBody } {
    if (isWorkflowError(exception)) {
      return {
        status: STATUS_BY_CODE[exception.code],
        body: { code: exception.code, message: exception.message, details: exception.details ?? null },
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      if (status < 500) {
        return { status, body: { code: HttpStatus[status] ?? 'HTTP_ERROR', message: exception.message, details: null } };
      }
    }

    this.logger.error(exception instanceof Error ? (exception.stack ?? exception.message) : String(exception));
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: { code: 'INTERNAL_ERROR', message: 'Internal server error', details: null },
    };
  }
}
