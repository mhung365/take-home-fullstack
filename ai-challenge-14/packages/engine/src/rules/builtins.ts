import { z } from 'zod';
import type { RuleDefinition, RuleRegistry } from './types';
import { isEmpty, isSettingsRef, show, typeName } from './values';

const name = z.string().min(1);

function ruleSchema<S extends z.ZodRawShape>(shape: S) {
  return z.strictObject({ rule: name, field: name, message: name.optional(), ...shape });
}

function defineRule<P>(def: RuleDefinition<P>): RuleDefinition<P> {
  return def;
}

const notEmpty = defineRule({
  name: 'notEmpty',
  params: ruleSchema({}),
  evaluate: ({ field }, ctx) =>
    isEmpty(ctx.get(field))
      ? { passed: false, message: `${field} is required` }
      : { passed: true, message: `${field} is present` },
});

const providedInRequest = defineRule({
  name: 'providedInRequest',
  params: ruleSchema({}),
  evaluate: ({ field }, ctx) => {
    const value = Object.hasOwn(ctx.payload, field) ? ctx.payload[field] : undefined;
    return isEmpty(value)
      ? { passed: false, message: `${field} must be provided in this request` }
      : { passed: true, message: `${field} is provided in this request` };
  },
});

const containsAll = defineRule({
  name: 'containsAll',
  params: ruleSchema({
    values: z.array(z.unknown()).optional(),
    ref: name.optional(),
  }).refine((p) => (p.values === undefined) !== (p.ref === undefined), {
    message: 'containsAll requires exactly one of values or ref',
  }),
  evaluate: ({ field, values, ref }, ctx) => {
    const actual = ctx.get(field) ?? [];
    if (!Array.isArray(actual)) return { passed: false, message: `${field} must be an array, got ${typeName(actual)}` };

    const expected = values ?? ctx.resolveRef(ref!);
    if (!Array.isArray(expected)) {
      return { passed: false, message: `${ref} must be an array, got ${typeName(expected)}` };
    }

    const missing = expected.filter((v) => !actual.includes(v));
    return missing.length > 0
      ? { passed: false, message: `Missing required ${field}: ${missing.map(String).join(', ')}` }
      : { passed: true, message: `${field} contains all of: ${expected.map(String).join(', ')}` };
  },
});

const lte = defineRule({
  name: 'lte',
  params: ruleSchema({ ref: name }),
  evaluate: ({ field, ref }, ctx) => {
    const value = ctx.get(field);
    const limit = ctx.resolveRef(ref);
    if (typeof value !== 'number') return { passed: false, message: `${field} must be a number, got ${typeName(value)}` };
    if (typeof limit !== 'number') return { passed: false, message: `${ref} must be a number, got ${typeName(limit)}` };
    return value <= limit
      ? { passed: true, message: `${field} ${value} is within ${ref} ${limit}` }
      : { passed: false, message: `${field} ${value} exceeds ${ref} ${limit}` };
  },
});

const eq = defineRule({
  name: 'eq',
  params: ruleSchema({ value: z.union([z.string(), z.number(), z.boolean(), z.null()]) }),
  evaluate: ({ field, value }, ctx) =>
    ctx.get(field) === value
      ? { passed: true, message: `${field} is ${show(value)}` }
      : { passed: false, message: `${field} must be ${show(value)}` },
});

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const daysElapsed = defineRule({
  name: 'daysElapsed',
  params: ruleSchema({
    days: z.union([z.int().nonnegative(), z.string().refine(isSettingsRef, 'days must be a number or $settings.<key>')]),
  }),
  evaluate: ({ field, days }, ctx) => {
    const required = ctx.resolveValue(days);
    if (typeof required !== 'number') return { passed: false, message: `${days} must be a number, got ${typeName(required)}` };

    const raw = ctx.get(field);
    const since = typeof raw === 'string' || raw instanceof Date ? new Date(raw) : undefined;
    if (!since || Number.isNaN(since.getTime())) {
      return { passed: false, message: `${field} must be a valid date, got ${show(raw)}` };
    }

    const elapsed = Math.max(0, Math.floor((ctx.now.getTime() - since.getTime()) / MS_PER_DAY));
    return elapsed >= required
      ? { passed: true, message: `${elapsed} of ${required} days elapsed since ${field}` }
      : { passed: false, message: `Only ${elapsed} of ${required} days elapsed since ${field}` };
  },
});

const userHasRole = defineRule({
  name: 'userHasRole',
  params: ruleSchema({ role: name }),
  validate: ({ role }, workflow) =>
    workflow.roles.includes(role)
      ? []
      : [{ key: 'role', message: `Rule userHasRole uses unknown role ${role}. Known roles: ${workflow.roles.join(', ')}` }],
  evaluate: ({ field, role }, ctx) => {
    const id = ctx.get(field);
    if (isEmpty(id)) return { passed: false, message: `${field} is required` };

    const user = typeof id === 'string' ? ctx.findUser(id) : undefined;
    if (!user) return { passed: false, message: `${field} ${String(id)} is not a known user` };
    return user.role === role
      ? { passed: true, message: `${field} ${id} has role ${role}` }
      : { passed: false, message: `${field} ${id} has role ${user.role}, expected ${role}` };
  },
});

export const defaultRules: RuleRegistry = new Map(
  [notEmpty, providedInRequest, containsAll, lte, eq, daysElapsed, userHasRole].map((r) => [r.name, r]),
);
