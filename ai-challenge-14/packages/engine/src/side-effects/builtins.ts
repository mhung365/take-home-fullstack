import { z } from 'zod';
import { isEmpty, readPath } from '../rules/values';
import { renderTemplate, templateVariables } from './template';
import type { SideEffectConfigIssue, SideEffectContext, SideEffectHandler, SideEffectRegistry } from './types';

export interface BuiltinSideEffectOptions {
  /** Where the mock integrations write their output. Defaults to console.log. */
  log?: (line: string) => void;
  /** Defaults to a random UUID with a pr- prefix. */
  paymentRequestId?: () => string;
}

const name = z.string().min(1);
const UNKNOWN_FIELD = 'is not a core field, an input, or a field written by an action or side effect';
const NOW = '$now';

function defineSideEffect<P>(def: SideEffectHandler<P>): SideEffectHandler<P> {
  return def;
}

export function createBuiltinSideEffects(options: BuiltinSideEffectOptions = {}): SideEffectRegistry {
  const log = options.log ?? ((line: string) => console.log(line));
  const paymentRequestId = options.paymentRequestId ?? (() => `pr-${globalThis.crypto.randomUUID()}`);

  const notify = defineSideEffect({
    name: 'notify',
    params: z.strictObject({
      to: z.string().regex(/^(member|role:\S+|user:\S+)$/, 'to must be member, role:<role> or user:<field>'),
      template: name,
    }),
    validate: ({ to, template }, ctx) => {
      const issues: SideEffectConfigIssue[] = [];
      const [kind, target] = splitRecipient(to);
      if (kind === 'role' && !ctx.workflow.roles.includes(target)) {
        issues.push({
          key: 'to',
          message: `Notify recipient ${to} uses unknown role ${target}. Known roles: ${ctx.workflow.roles.join(', ')}`,
        });
      }
      if (kind === 'user' && !ctx.isKnownField(target)) {
        issues.push({ key: 'to', message: `Notify recipient ${to} reads ${target}, which ${UNKNOWN_FIELD}` });
      }
      for (const variable of templateVariables(template)) {
        if (!ctx.isKnownField(variable)) {
          issues.push({ key: 'template', message: `Template variable {{${variable}}} ${UNKNOWN_FIELD}` });
        }
      }
      return issues;
    },
    // Sent even with empty variables: a partial notice beats none, and the audit shows what was missing.
    run: ({ to, template }, ctx) => {
      const recipients = resolveRecipients(to, ctx);
      const { text: message, missing } = renderTemplate(template, ctx.view);
      log(`[NOTIFY → ${recipients.join(', ')}] ${message}`);
      return {
        result: { to, recipients, message, ...(missing.length > 0 && { missingVariables: missing }) },
      };
    },
  });

  const setField = defineSideEffect({
    name: 'setField',
    params: z.strictObject({ field: name, value: z.json() }),
    writes: ({ field }) => [field],
    validate: ({ field, value }, ctx) => {
      const issues: SideEffectConfigIssue[] = [];
      if (ctx.coreFields.includes(field)) {
        issues.push({
          key: 'field',
          message: `Side effect setField field ${field} collides with core claim field. Core fields: ${ctx.coreFields.join(', ')}`,
        });
      }
      if (typeof value === 'string' && value.startsWith('$') && value !== NOW) {
        issues.push({ key: 'value', message: `Unknown special value ${value}; the only one supported is ${NOW}` });
      }
      return issues;
    },
    run: ({ field, value }, ctx) => {
      const resolved = value === NOW ? ctx.now.toISOString() : value;
      log(`[SET_FIELD] ${ctx.claim.id}.${field} = ${JSON.stringify(resolved)}`);
      return { result: { field, value: resolved }, dataPatch: { [field]: resolved } };
    },
  });

  const createPaymentRequest = defineSideEffect({
    name: 'createPaymentRequest',
    params: z.strictObject({}),
    writes: () => ['paymentRequest'],
    run: (_params, ctx) => {
      const id = paymentRequestId();
      const { amount } = ctx.claim;
      log(`[PAYMENT] Created payment request ${id} for claim ${ctx.claim.id} (amount ${amount})`);
      return {
        result: { paymentRequestId: id, amount },
        dataPatch: { paymentRequest: { id, amount, createdAt: ctx.now.toISOString() } },
      };
    },
  });

  const triggerPaymentSystem = defineSideEffect({
    name: 'triggerPaymentSystem',
    params: z.strictObject({}),
    writes: () => ['paymentInitiatedAt'],
    run: (_params, ctx) => {
      const id = readPath(ctx.view, 'paymentRequest.id');
      if (isEmpty(id)) throw new Error(`Claim ${ctx.claim.id} has no payment request`);
      const initiatedAt = ctx.now.toISOString();
      log(`[PAYMENT] Triggered payment system for payment request ${String(id)} (claim ${ctx.claim.id})`);
      return { result: { paymentRequestId: id, initiatedAt }, dataPatch: { paymentInitiatedAt: initiatedAt } };
    },
  });

  return new Map<string, SideEffectHandler<any>>(
    [notify, setField, createPaymentRequest, triggerPaymentSystem].map((h) => [h.name, h]),
  );
}

export const defaultSideEffects: SideEffectRegistry = createBuiltinSideEffects();

function splitRecipient(to: string): ['member' | 'role' | 'user', string] {
  if (to === 'member') return ['member', ''];
  const colon = to.indexOf(':');
  return [to.slice(0, colon) as 'role' | 'user', to.slice(colon + 1)];
}

function resolveRecipients(to: string, ctx: SideEffectContext): string[] {
  const [kind, target] = splitRecipient(to);
  if (kind === 'member') return [ctx.claim.memberId];

  if (kind === 'role') {
    const ids = ctx.users.filter((u) => u.role === target).map((u) => u.id);
    if (ids.length === 0) throw new Error(`No users with role ${target}`);
    return ids;
  }

  const userId = readPath(ctx.view, target);
  if (isEmpty(userId)) throw new Error(`Notify recipient field ${target} is empty`);
  if (typeof userId !== 'string' || !ctx.users.some((u) => u.id === userId)) {
    throw new Error(`Notify recipient field ${target} holds unknown user ${String(userId)}`);
  }
  return [userId];
}
