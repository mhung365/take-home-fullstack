import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { InMemoryWorkflowStore, WorkflowEngine, type LoadedConfig, type WorkflowStore } from '@claims/engine';
import { ConfigController } from './config.controller';
import { ErrorFilter } from './errors/error.filter';
import { HealthController } from './health.controller';
import { UserGuard } from './identity/user.guard';
import { WORKFLOW_CONFIG, WORKFLOW_STORE } from './tokens';
import { UsersController } from './users.controller';

@Module({})
export class AppModule {
  /** config must already be validated: a broken config never reaches Nest. */
  static forRoot(config: LoadedConfig): DynamicModule {
    return {
      module: AppModule,
      controllers: [ConfigController, UsersController, HealthController],
      providers: [
        { provide: WORKFLOW_CONFIG, useValue: config },
        { provide: WORKFLOW_STORE, useFactory: (): WorkflowStore => new InMemoryWorkflowStore() },
        {
          provide: WorkflowEngine,
          inject: [WORKFLOW_CONFIG, WORKFLOW_STORE],
          useFactory: (cfg: LoadedConfig, store: WorkflowStore) => new WorkflowEngine({ config: cfg, store }),
        },
        { provide: APP_GUARD, useClass: UserGuard },
        { provide: APP_FILTER, useClass: ErrorFilter },
      ],
    };
  }
}
