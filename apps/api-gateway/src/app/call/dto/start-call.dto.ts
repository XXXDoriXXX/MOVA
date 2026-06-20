import { createZodDto } from 'nestjs-zod';
import parsePhoneNumberFromString from 'libphonenumber-js';
import { z } from 'zod';

const SHORT_CODE = /^[*#]?\d{2,6}$/;

const PhoneSchema = z
  .string()
  .trim()
  .min(2)
  .max(20)
  .transform((raw, ctx) => {
    if (SHORT_CODE.test(raw)) return raw;
    const parsed = parsePhoneNumberFromString(raw);
    if (!parsed?.isValid()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Invalid phone number',
      });
      return z.NEVER;
    }
    return parsed.number;
  });

export const StartCallSchema = z.object({
  targetPhone: PhoneSchema,
  templateId: z.string().uuid().optional(),
  userName: z.string().trim().min(1).max(120).optional(),
  userRole: z.string().trim().min(1).max(120).optional(),
  callReason: z.string().trim().min(1).max(500).optional(),
  // Whether the agent voices its opening greeting (the deaf+assistant
  // disclosure). Off for people who already know the caller — e.g. family.
  // Absent = announce (preserves existing behaviour).
  announceGreeting: z.boolean().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

export class StartCallDto extends createZodDto(StartCallSchema) {}
