import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { PlanCode } from '@mova-back/shared-database';

import { MAX_TOPUP_CENTS, MIN_TOPUP_CENTS } from '../billing.service';

export const TopupSchema = z.object({
  amountCents: z
    .number()
    .int()
    .min(MIN_TOPUP_CENTS, `Minimum topup is ${MIN_TOPUP_CENTS} cents`)
    .max(MAX_TOPUP_CENTS, `Maximum topup is ${MAX_TOPUP_CENTS} cents`),
});
export class TopupDto extends createZodDto(TopupSchema) {}

export const SubscribeSchema = z.object({
  planCode: z.nativeEnum(PlanCode),
});
export class SubscribeDto extends createZodDto(SubscribeSchema) {}
