import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { UserLanguage } from '@mova-back/shared-database';

const EmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(254)
  .email();

const PasswordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(72, 'Password must be at most 72 characters (bcrypt limit)')
  .refine((p) => /[A-Za-zА-Яа-яЇїІіЄєҐґ]/.test(p), {
    message: 'Password must contain at least one letter',
  })
  .refine((p) => /\d/.test(p), {
    message: 'Password must contain at least one digit',
  });

const NameSchema = z.string().trim().min(1).max(120);


// Public handle: 3–30 chars, letters/digits/underscore/dot, case-insensitive.
export const UsernameSchema = z
  .string()
  .trim()
  .min(3)
  .max(30)
  .regex(/^[a-zA-Z0-9_.]+$/, {
    message: 'Username: letters, digits, "_" or "." only',
  })
  .transform((s) => s.toLowerCase());

export const RegisterSchema = z.object({
  email: EmailSchema,
  password: PasswordSchema,
  name: NameSchema,
  username: UsernameSchema,
});
export class RegisterDto extends createZodDto(RegisterSchema) {}

export const LoginSchema = z.object({
  email: EmailSchema,
  password: z.string().min(1).max(72),
});
export class LoginDto extends createZodDto(LoginSchema) {}

export const ResendVerificationSchema = z.object({
  email: EmailSchema,
});
export class ResendVerificationDto extends createZodDto(
  ResendVerificationSchema,
) {}

export const RefreshSchema = z.object({
  refreshToken: z.string().min(1).max(500),
});
export class RefreshDto extends createZodDto(RefreshSchema) {}

export const GoogleSignInSchema = z.object({
  idToken: z.string().min(1).max(4096),
});
export class GoogleSignInDto extends createZodDto(GoogleSignInSchema) {}

export const LogoutSchema = z.object({
  refreshToken: z.string().min(1).max(500),
});
export class LogoutDto extends createZodDto(LogoutSchema) {}

export const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(72),
  newPassword: PasswordSchema,
});
export class ChangePasswordDto extends createZodDto(ChangePasswordSchema) {}

export const UpdateProfileSchema = z
  .object({
    name: NameSchema.optional(),
    language: z.nativeEnum(UserLanguage).optional(),
    preferredVoice: z.string().trim().min(1).max(100).optional(),
    preferredVoiceGender: z.enum(['female', 'male']).optional(),
    preferredLlmProvider: z.string().trim().min(1).max(50).optional(),
    preferredLlmModel: z.string().trim().min(1).max(100).optional(),
    preferredTtsProvider: z.string().trim().min(1).max(50).optional(),
    isDeafMute: z.boolean().optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided',
  });
export class UpdateProfileDto extends createZodDto(UpdateProfileSchema) {}

export const DeleteAccountSchema = z.object({
  password: z.string().min(1).max(72),
});
export class DeleteAccountDto extends createZodDto(DeleteAccountSchema) {}
