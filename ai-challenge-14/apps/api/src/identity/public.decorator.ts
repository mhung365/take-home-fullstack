import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'isPublic';

/** Skips the X-User-Id check for a controller or route. */
export const Public = () => SetMetadata(IS_PUBLIC, true);
