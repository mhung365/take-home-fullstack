import { Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { WorkflowEngine, type SystemTasksResult, type UserConfig } from '@claims/engine';
import { CurrentUser } from './identity/current-user.decorator';

@Controller('system')
export class SystemController {
  constructor(private readonly engine: WorkflowEngine) {}

  @Post('run-tasks')
  @HttpCode(HttpStatus.OK)
  runTasks(@CurrentUser() user: UserConfig): Promise<SystemTasksResult> {
    return this.engine.runSystemTasks(user.id);
  }
}
