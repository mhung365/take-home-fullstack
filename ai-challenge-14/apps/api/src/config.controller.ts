import { Controller, Get, Inject } from '@nestjs/common';
import type { LoadedConfig, WorkflowConfig } from '@claims/engine';
import { Public } from './identity/public.decorator';
import { WORKFLOW_CONFIG } from './tokens';

@Public()
@Controller('config')
export class ConfigController {
  constructor(@Inject(WORKFLOW_CONFIG) private readonly config: LoadedConfig) {}

  @Get()
  get(): WorkflowConfig {
    return this.config.workflow;
  }
}
