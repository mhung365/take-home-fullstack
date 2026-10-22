import { Controller, Get } from '@nestjs/common';
import { ENGINE_NAME } from '@claims/engine';

@Controller('health')
export class HealthController {
  @Get()
  check() {
    return { status: 'ok', engine: ENGINE_NAME };
  }
}
