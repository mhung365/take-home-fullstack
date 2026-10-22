import { Controller, Get, HttpStatus, Inject, Logger, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { Pool } from 'pg';
import { Public } from './identity/public.decorator';
import { PG_POOL } from './tokens';

@Public()
@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** Sets 503 itself: ErrorFilter turns every 5xx exception into a 500 INTERNAL_ERROR. */
  @Get()
  async check(@Res({ passthrough: true }) res: Response) {
    try {
      await this.pool.query('SELECT 1');
      return { status: 'ok', database: 'ok' };
    } catch (error) {
      // A refused connection is an AggregateError (IPv4 + IPv6 attempts) with an empty message.
      const { code, message } = error as Error & { code?: string };
      this.logger.error(`Database ping failed: ${message || code || String(error)}`);
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
      return { status: 'unavailable', database: 'unreachable' };
    }
  }
}
