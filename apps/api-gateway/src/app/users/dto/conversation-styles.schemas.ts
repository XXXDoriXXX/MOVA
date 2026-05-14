import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  CUSTOM_STYLE_INSTRUCTIONS_MAX,
  CUSTOM_STYLE_NAME_MAX,
} from '@mova-back/shared-realtime';

/**
 * Schemas mirror the bounds enforced server-side in
 * ConversationStylesService. The shared-realtime constants are the single
 * source of truth — adjusting them here without there (or vice-versa) would
 * break the contract.
 */

export const CreateCustomStyleSchema = z.object({
  name: z.string().trim().min(1).max(CUSTOM_STYLE_NAME_MAX),
  instructions: z.string().trim().min(1).max(CUSTOM_STYLE_INSTRUCTIONS_MAX),
});
export class CreateCustomStyleDto extends createZodDto(CreateCustomStyleSchema) {}

export const UpdateCustomStyleSchema = z
  .object({
    name: z.string().trim().min(1).max(CUSTOM_STYLE_NAME_MAX).optional(),
    instructions: z
      .string()
      .trim()
      .min(1)
      .max(CUSTOM_STYLE_INSTRUCTIONS_MAX)
      .optional(),
  })
  .refine(
    (value) => value.name !== undefined || value.instructions !== undefined,
    { message: 'At least one of `name`, `instructions` is required' },
  );
export class UpdateCustomStyleDto extends createZodDto(UpdateCustomStyleSchema) {}

/**
 * Either set a styleId or explicitly clear it (null). The wire format is
 * a string column server-side; the only valid clear-signal is JSON null.
 */
export const SetPreferredStyleSchema = z.object({
  styleId: z.string().min(1).max(80).nullable(),
});
export class SetPreferredStyleDto extends createZodDto(SetPreferredStyleSchema) {}
