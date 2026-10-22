import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import type { z } from 'zod';
import { OffsetClock } from './clock/offset-clock';
import { advanceClockBody } from './validation/schemas';
import { ZodPipe } from './validation/zod.pipe';

/** Registered only when DEMO_MODE=true (see AppModule). */
@Controller('dev')
export class DevController {
  constructor(private readonly clock: OffsetClock) {}

  @Post('clock/advance')
  @HttpCode(HttpStatus.OK)
  advance(@Body(new ZodPipe(advanceClockBody)) body: z.output<typeof advanceClockBody>) {
    this.clock.advanceDays(body.days);
    return { now: this.clock.now().toISOString(), offsetMs: this.clock.offset };
  }
}
