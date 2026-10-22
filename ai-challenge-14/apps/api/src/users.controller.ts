import { Controller, Get, Inject } from '@nestjs/common';
import type { LoadedConfig, UsersConfig } from '@claims/engine';
import { Public } from './identity/public.decorator';
import { WORKFLOW_CONFIG } from './tokens';

@Public()
@Controller('users')
export class UsersController {
  constructor(@Inject(WORKFLOW_CONFIG) private readonly config: LoadedConfig) {}

  @Get()
  list(): UsersConfig {
    return this.config.users;
  }
}
