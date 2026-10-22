export const SETTINGS_PREFIX = '$settings.';

export function isSettingsRef(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(SETTINGS_PREFIX);
}

export function readPath(source: unknown, path: string): unknown {
  let current = source;
  for (const key of path.split('.')) {
    if (typeof current !== 'object' || current === null || !Object.hasOwn(current, key)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Empty = undefined, null, blank string, empty array, empty plain object. 0 and false are values. */
export function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    return (proto === Object.prototype || proto === null) && Object.keys(value).length === 0;
  }
  return false;
}

export function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

export function show(value: unknown): string {
  return value === undefined ? 'undefined' : JSON.stringify(value);
}
