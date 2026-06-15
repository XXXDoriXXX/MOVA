import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// Was a class-validator DTO, but the app's only global pipe is ZodValidationPipe
// (every other api-gateway DTO is a createZodDto) — so none of the decorators
// ran and malformed search queries reached the SQL as raw 500s. Mirror the
// house convention so validation actually executes and bad input is a 400.
const isoDate = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), {
    message: 'must be a valid ISO date',
  });

export const SearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  from: isoDate.optional(),
  to: isoDate.optional(),
  templateId: z.string().uuid().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

export class SearchQueryDto extends createZodDto(SearchQuerySchema) {}
