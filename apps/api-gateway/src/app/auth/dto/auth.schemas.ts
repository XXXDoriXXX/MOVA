import { createZodDto } from 'nestjs-zod';
import parsePhoneNumberFromString from 'libphonenumber-js';
import { z } from 'zod';

import { UserLanguage } from '@mova-back/shared-database';

/**
 * Auth-related DTO schemas (Zod + nestjs-zod).
 *
 * Conventions:
 *   - Email is normalized to lowercase before validation/storage.
 *   - Password constraints: 8..72 chars (bcrypt input limit), at least one
 *     letter + one digit. We deliberately do NOT enforce special chars —
 *     length entropy beats character-class entropy (NIST SP 800-63B).
 *   - Phone numbers go through libphonenumber-js for canonical E.164.
 */

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

/**
 * Optional E.164 phone. Accepts any phone format the user types — converts
 * to canonical E.164 (e.g. "+380501234567"). Rejects unparseable input.
 */
const PhoneSchema = z
  .string()
  .trim()
  .min(5)
  .max(20)
  .transform((raw, ctx) => {
    const parsed = parsePhoneNumberFromString(raw);
    if (!parsed?.isValid()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Invalid phone number',
      });
      return z.NEVER;
    }
    return parsed.number; // canonical +CCC...
  });

// ─── Register ───────────────────────────────────────
export const RegisterSchema = z.object({
  email: EmailSchema,
  password: PasswordSchema,
  name: NameSchema,
});
export class RegisterDto extends createZodDto(RegisterSchema) {}

// ─── Login ──────────────────────────────────────────
export const LoginSchema = z.object({
  email: EmailSchema,
  password: z.string().min(1).max(72), // no strength check on login
});
export class LoginDto extends createZodDto(LoginSchema) {}

// ─── Refresh ────────────────────────────────────────
export const RefreshSchema = z.object({
  refreshToken: z.string().min(1).max(500),
});
export class RefreshDto extends createZodDto(RefreshSchema) {}

// ─── Google Sign-In ─────────────────────────────────
export const GoogleSignInSchema = z.object({
  idToken: z.string().min(1).max(4096),
});
export class GoogleSignInDto extends createZodDto(GoogleSignInSchema) {}

// ─── Logout ─────────────────────────────────────────
export const LogoutSchema = z.object({
  refreshToken: z.string().min(1).max(500),
});
export class LogoutDto extends createZodDto(LogoutSchema) {}

// ─── Change password ────────────────────────────────
export const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(72),
  newPassword: PasswordSchema,
});
export class ChangePasswordDto extends createZodDto(ChangePasswordSchema) {}

// ─── Update profile ─────────────────────────────────
export const UpdateProfileSchema = z
  .object({
    name: NameSchema.optional(),
    phoneNumber: PhoneSchema.optional(),
    language: z.nativeEnum(UserLanguage).optional(),
    preferredVoice: z.string().trim().min(1).max(100).optional(),
    preferredLlmProvider: z.string().trim().min(1).max(50).optional(),
    preferredLlmModel: z.string().trim().min(1).max(100).optional(),
    preferredTtsProvider: z.string().trim().min(1).max(50).optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided',
  });
export class UpdateProfileDto extends createZodDto(UpdateProfileSchema) {}

// ─── Delete account ─────────────────────────────────
export const DeleteAccountSchema = z.object({
  password: z.string().min(1).max(72),
});
export class DeleteAccountDto extends createZodDto(DeleteAccountSchema) {}
