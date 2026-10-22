import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, Query } from '@nestjs/common';
import {
  WorkflowEngine,
  claimNotFound,
  type AcknowledgeResult,
  type AuditEntry,
  type AvailableTransitions,
  type Claim,
  type TransitionResult,
  type UserConfig,
  type WorkflowStore,
} from '@claims/engine';
import type { z } from 'zod';
import { CurrentUser } from './identity/current-user.decorator';
import { WORKFLOW_STORE } from './tokens';
import { acknowledgeBody, createClaimBody, listClaimsQuery, transitionBody } from './validation/schemas';
import { ZodPipe } from './validation/zod.pipe';

/** Writes go through the engine; reads go straight to the store, which never hands out live objects. */
@Controller('claims')
export class ClaimsController {
  constructor(
    private readonly engine: WorkflowEngine,
    @Inject(WORKFLOW_STORE) private readonly store: WorkflowStore,
  ) {}

  @Post()
  create(
    @CurrentUser() user: UserConfig,
    @Body(new ZodPipe(createClaimBody)) body: z.output<typeof createClaimBody>,
  ): Promise<Claim> {
    return this.engine.createClaim(user.id, body as Parameters<WorkflowEngine['createClaim']>[1]);
  }

  @Get()
  list(@Query(new ZodPipe(listClaimsQuery, 'query')) query: z.output<typeof listClaimsQuery>): Promise<Claim[]> {
    return this.store.listClaims(query.status ? { status: query.status } : undefined);
  }

  @Get(':id')
  get(@CurrentUser() user: UserConfig, @Param('id') id: string): Promise<AvailableTransitions> {
    return this.engine.getAvailableTransitions(id, user.id);
  }

  @Post(':id/transitions')
  @HttpCode(HttpStatus.OK)
  transition(
    @CurrentUser() user: UserConfig,
    @Param('id') id: string,
    @Body(new ZodPipe(transitionBody)) body: z.output<typeof transitionBody>,
  ): Promise<TransitionResult> {
    return this.engine.transition(id, user.id, body);
  }

  @Post(':id/acknowledge')
  @HttpCode(HttpStatus.OK)
  acknowledge(
    @CurrentUser() user: UserConfig,
    @Param('id') id: string,
    @Body(new ZodPipe(acknowledgeBody)) body: z.output<typeof acknowledgeBody>,
  ): Promise<AcknowledgeResult> {
    return this.engine.acknowledge(id, user.id, body.notes, body.expectedVersion);
  }

  @Get(':id/audit')
  async audit(@Param('id') id: string): Promise<AuditEntry[]> {
    await this.requireClaim(id);
    return this.store.listAuditByClaim(id);
  }

  private async requireClaim(id: string): Promise<Claim> {
    const claim = await this.store.getClaim(id);
    if (!claim) throw claimNotFound(id);
    return claim;
  }
}
