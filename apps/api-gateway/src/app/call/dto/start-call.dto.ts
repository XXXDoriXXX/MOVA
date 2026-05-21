import { createZodDto } from 'nestjs-zod';
import parsePhoneNumberFromString from 'libphonenumber-js';
import { z } from 'zod';

/**
 * StartCallDto — request body for `POST /v1/calls/start`.
 *
 * Migrated from class-validator to Zod (nestjs-zod) for consistency with
 * the rest of the codebase (Phase 0). Phone numbers are normalized to
 * canonical E.164 via libphonenumber-js so downstream services don't have
 * to re-parse.
 *
 * Backward-compat: legacy fields (userName, userRole, callReason) are kept
 * optional because the existing agent-worker reads them from the dispatched
 * context. New flows should rely on `templateId` instead.
 */
// Provider short codes (e.g. Zadarma's `101` voice-test, `100` voicemail).
// Bare digits 2-6 long, optionally prefixed with `*` or `#`. Passed through
// to the SIP trunk unchanged — libphonenumber would reject them.
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
  /** Optional template id — when null/missing, server falls back to user's default. */
  templateId: z.string().uuid().optional(),
  /**
   * @deprecated kept for back-compat with existing agent-worker contracts.
   * Will be removed once agent-worker reads everything from the resolved
   * Template + Conversation context.
   */
  userName: z.string().trim().min(1).max(120).optional(),
  /** @deprecated see userName */
  userRole: z.string().trim().min(1).max(120).optional(),
  /** @deprecated see userName */
  callReason: z.string().trim().min(1).max(500).optional(),
  /** Free-form provider config override (used by existing agent-worker). */
  config: z.record(z.string(), z.unknown()).optional(),
});

export class StartCallDto extends createZodDto(StartCallSchema) {}
