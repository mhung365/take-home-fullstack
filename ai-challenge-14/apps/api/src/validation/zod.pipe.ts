import type { PipeTransform } from '@nestjs/common';
import { validationError } from '@claims/engine';
import type { z } from 'zod';

/** Parses with schema; on failure throws VALIDATION_ERROR listing every issue, like the engine does. */
export class ZodPipe<S extends z.ZodType> implements PipeTransform<unknown, z.output<S>> {
  constructor(
    private readonly schema: S,
    private readonly source = 'body',
  ) {}

  transform(value: unknown): z.output<S> {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;
    throw validationError(
      result.error.issues.map((issue) => {
        const field = issue.path.map(String).join('.');
        return { field, message: `${field || this.source}: ${issue.message}` };
      }),
    );
  }
}
