import { z } from 'zod';

const name = z.string().min(1);

export type RuleCondition = {
  rule: string;
  field?: string;
  message?: string;
  [param: string]: unknown;
};

export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | RuleCondition;

// Rule-specific params (ref, values, role, ...) are validated by the rule registry.
const ruleConditionSchema = z.looseObject({
  rule: name,
  field: name.optional(),
  message: name.optional(),
});

const allSchema = z.strictObject({ all: z.array(z.lazy(() => conditionSchema)).min(1) });
const anySchema = z.strictObject({ any: z.array(z.lazy(() => conditionSchema)).min(1) });
const notSchema = z.strictObject({ not: z.lazy(() => conditionSchema) });

function pickConditionSchema(value: unknown) {
  if (typeof value === 'object' && value !== null) {
    if ('all' in value) return allSchema;
    if ('any' in value) return anySchema;
    if ('not' in value) return notSchema;
  }
  return ruleConditionSchema;
}

export const conditionSchema: z.ZodType<Condition> = z.unknown().transform((value, ctx) => {
  const result = pickConditionSchema(value).safeParse(value);
  if (!result.success) {
    for (const issue of result.error.issues) {
      ctx.addIssue({ code: 'custom', message: issue.message, path: issue.path });
    }
    return z.NEVER;
  }
  return result.data as Condition;
});

export const sideEffectSchema = z.strictObject({
  name,
  params: z.record(z.string(), z.unknown()).optional(),
});

export const stateSchema = z.strictObject({
  id: name,
  description: name,
  terminal: z.boolean().optional(),
});

export const transitionSchema = z.strictObject({
  id: name,
  from: name,
  to: name,
  description: name,
  roles: z.array(name).min(1),
  inputs: z.array(name).default([]),
  reasonField: name.optional(),
  preconditions: conditionSchema.optional(),
  sideEffects: z.array(sideEffectSchema).default([]),
  cycleLimit: z
    .strictObject({
      max: z.int().positive(),
      message: name,
    })
    .optional(),
});

export const actionsSchema = z.strictObject({
  createClaim: z.strictObject({
    roles: z.array(name).min(1),
    inputs: z.array(name).default([]),
  }),
  acknowledge: z.strictObject({
    roles: z.array(name).min(1),
    allowedStates: z.array(name).min(1),
  }),
  runSystemTasks: z.strictObject({
    roles: z.array(name).min(1),
  }),
});

export const workflowConfigSchema = z.strictObject({
  version: z.literal(1),
  initialState: name,
  roles: z.array(name).min(1),
  settings: z.record(z.string(), z.unknown()).default({}),
  states: z.array(stateSchema).min(1),
  actions: actionsSchema,
  transitions: z.array(transitionSchema),
});

export const userSchema = z.strictObject({
  id: name,
  name,
  role: name,
});

export const usersConfigSchema = z.strictObject({
  users: z.array(userSchema).min(1),
});

export type StateConfig = z.infer<typeof stateSchema>;
export type SideEffectConfig = z.infer<typeof sideEffectSchema>;
export type TransitionConfig = z.infer<typeof transitionSchema>;
export type ActionsConfig = z.infer<typeof actionsSchema>;
export type WorkflowConfig = z.infer<typeof workflowConfigSchema>;
export type UserConfig = z.infer<typeof userSchema>;
export type UsersConfig = z.infer<typeof usersConfigSchema>;
