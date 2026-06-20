import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const UpdateCostRateSchema = z.object({
  // The new human rate value (e.g. 0.59, 152, 6, 41.5). Non-negative; the
  // rateUnit on the row defines what it means.
  rate: z.coerce.number().min(0).max(1_000_000),
});

export class UpdateCostRateDto extends createZodDto(UpdateCostRateSchema) {}
