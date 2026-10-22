import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { WorkflowError, unknownUser, type LoadedConfig, type UserConfig } from '@claims/engine';
import type { Request } from 'express';
import { WORKFLOW_CONFIG } from '../tokens';
import { IS_PUBLIC } from './public.decorator';

export const USER_HEADER = 'x-user-id';

export interface RequestWithUser extends Request {
  user: UserConfig;
}

/** Resolves X-User-Id against users.json; the role always comes from there, never from the client. */
@Injectable()
export class UserGuard implements CanActivate {
  private readonly users: Map<string, UserConfig>;

  constructor(
    private readonly reflector: Reflector,
    @Inject(WORKFLOW_CONFIG) config: LoadedConfig,
  ) {
    this.users = new Map(config.users.users.map((u) => [u.id, u]));
  }

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const userId = request.header(USER_HEADER)?.trim();
    if (!userId) throw new WorkflowError('UNKNOWN_USER', 'Missing X-User-Id header');

    const user = this.users.get(userId);
    if (!user) throw unknownUser(userId);
    request.user = user;
    return true;
  }
}
