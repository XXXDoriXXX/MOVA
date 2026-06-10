import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const StartPeerCallSchema = z.object({
  calleeUserId: z.string().uuid(),
  templateId: z.string().uuid().optional(),
});
export class StartPeerCallDto extends createZodDto(StartPeerCallSchema) {}
