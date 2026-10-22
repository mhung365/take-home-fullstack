import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { InMemoryWorkflowStore, WorkflowEngine, type LoadedConfig, type WorkflowStore } from '@claims/engine';
import { ClaimsController } from './claims.controller';
import { OffsetClock } from './clock/offset-clock';
import { ConfigController } from './config.controller';
import { DevController } from './dev.controller';
import { ErrorFilter } from './errors/error.filter';
import { HealthController } from './health.controller';
import { UserGuard } from './identity/user.guard';
import { SystemController } from './system.controller';
import { WORKFLOW_CONFIG, WORKFLOW_STORE } from './tokens';
import { UsersController } from './users.controller';

export interface AppOptions {
  /** Registers /dev/clock/advance. */
  demoMode: boolean;
}

@Module({})
export class AppModule {
  /** config must already be validated: a broken config never reaches Nest. */
  static forRoot(config: LoadedConfig, options: AppOptions): DynamicModule {
    return {
      module: AppModule,
      controllers: [
        ConfigController,
        UsersController,
        HealthController,
        ClaimsController,
        SystemController,
        ...(options.demoMode ? [DevController] : []),
      ],
      providers: [
        { provide: WORKFLOW_CONFIG, useValue: config },
        { provide: WORKFLOW_STORE, useFactory: (): WorkflowStore => new InMemoryWorkflowStore() },
        OffsetClock,
        {
          provide: WorkflowEngine,
          inject: [WORKFLOW_CONFIG, WORKFLOW_STORE, OffsetClock],
          useFactory: (cfg: LoadedConfig, store: WorkflowStore, clock: OffsetClock) =>
            new WorkflowEngine({ config: cfg, store, clock }),
        },
        { provide: APP_GUARD, useClass: UserGuard },
        { provide: APP_FILTER, useClass: ErrorFilter },
      ],
    };
  }
}
