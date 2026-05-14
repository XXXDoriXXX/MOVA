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

/**
 * Force-ending a call requires a reason for the audit trail — operators
 * shouldn't be able to terminate a user's call without leaving a paper
 * trail. Max 280 keeps the audit row + UI banner predictable.
 */
export const ForceEndConversationSchema = z.object({
  reason: z.string().trim().min(1).max(280),
});
export class ForceEndConversationDto extends createZodDto(
  ForceEndConversationSchema,
) {}

/**
 * Manually resolving an incident — `note` is the short explanation that
 * shows up alongside `resolvedAt` in the incidents dashboard.
 */
export const ResolveIncidentSchema = z.object({
  note: z.string().trim().min(1).max(280),
});
export class ResolveIncidentDto extends createZodDto(ResolveIncidentSchema) {}
