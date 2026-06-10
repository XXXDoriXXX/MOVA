import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { PushPlatform, PushTokenKind } from '@mova-back/shared-database';

export const RegisterPushTokenSchema = z.object({
  token: z.string().trim().min(1).max(512),
  platform: z.nativeEnum(PushPlatform),
  kind: z.nativeEnum(PushTokenKind).default(PushTokenKind.DATA),
});
export class RegisterPushTokenDto extends createZodDto(RegisterPushTokenSchema) {}

export const UnregisterPushTokenSchema = z.object({
  token: z.string().trim().min(1).max(512),
});
export class UnregisterPushTokenDto extends createZodDto(UnregisterPushTokenSchema) {}
