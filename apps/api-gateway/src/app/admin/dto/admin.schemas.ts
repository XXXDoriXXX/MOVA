import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Admin request schemas. The block reason is bounded so a careless admin
 * doesn't paste a 5000-char stacktrace into the `blockedReason` column.
 */

export const BlockUserSchema = z.object({
  reason: z.string().trim().min(1).max(280),
});
export class BlockUserDto extends createZodDto(BlockUserSchema) {}
