import { readPath } from '../rules/values';

const VARIABLE = /\{\{\s*([\w$.]+)\s*\}\}/g;

/** Variable paths in {{...}} placeholders, in order of first appearance. */
export function templateVariables(template: string): string[] {
  return [...new Set([...template.matchAll(VARIABLE)].map((m) => m[1]))];
}

export interface RenderedTemplate {
  text: string;
  /** Variables that rendered as empty (missing, null or ""), in order of first appearance. */
  missing: string[];
}

/** Missing and null values render as empty; non-strings render as JSON. */
export function renderTemplate(template: string, view: Readonly<Record<string, unknown>>): RenderedTemplate {
  const missing = new Set<string>();
  const text = template.replace(VARIABLE, (_, path: string) => {
    const value = format(readPath(view, path));
    if (value === '') missing.add(path);
    return value;
  });
  return { text, missing: [...missing] };
}

function format(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}
