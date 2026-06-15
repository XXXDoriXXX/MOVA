import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const ContactRequestSchema = z.object({
  // A nickname or an email — resolved server-side to a verified user.
  handle: z.string().trim().min(1).max(255),
});
export class ContactRequestDto extends createZodDto(ContactRequestSchema) {}

export const ContactSearchSchema = z.object({
  q: z.string().trim().min(1).max(255),
});
export class ContactSearchDto extends createZodDto(ContactSearchSchema) {}
