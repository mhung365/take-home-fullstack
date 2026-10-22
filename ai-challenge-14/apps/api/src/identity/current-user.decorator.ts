import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { UserConfig } from '@claims/engine';
import type { RequestWithUser } from './user.guard';

/** The user resolved by UserGuard; undefined on @Public() routes. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): UserConfig => context.switchToHttp().getRequest<RequestWithUser>().user,
);
