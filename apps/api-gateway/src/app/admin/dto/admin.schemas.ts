import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const BlockUserSchema = z.object({
  reason: z.string().trim().min(1).max(280),
});
export class BlockUserDto extends createZodDto(BlockUserSchema) {}

export const ForceEndConversationSchema = z.object({
  reason: z.string().trim().min(1).max(280),
});
export class ForceEndConversationDto extends createZodDto(
  ForceEndConversationSchema,
) {}

export const ResolveIncidentSchema = z.object({
  note: z.string().trim().min(1).max(280),
});
export class ResolveIncidentDto extends createZodDto(ResolveIncidentSchema) {}
