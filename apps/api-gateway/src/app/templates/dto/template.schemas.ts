import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { UserLanguage } from '@mova-back/shared-database';

const NameSchema = z.string().trim().min(1).max(80);
const DescriptionSchema = z.string().trim().min(1).max(280);
const SystemPromptSchema = z.string().min(1).max(10_000);

const ProviderHandleSchema = z.string().trim().min(1).max(50);
const ModelHandleSchema = z.string().trim().min(1).max(100);
const VoiceHandleSchema = z.string().trim().min(1).max(100);

export const CreateTemplateSchema = z.object({
  name: NameSchema,
  description: DescriptionSchema,
  systemPrompt: SystemPromptSchema,
  language: z.nativeEnum(UserLanguage).default(UserLanguage.UK),
  defaultVoice: VoiceHandleSchema.optional(),
  defaultLlmProvider: ProviderHandleSchema.optional(),
  defaultLlmModel: ModelHandleSchema.optional(),
  defaultTtsProvider: ProviderHandleSchema.optional(),
});
export class CreateTemplateDto extends createZodDto(CreateTemplateSchema) {}

export const UpdateTemplateSchema = CreateTemplateSchema.partial().refine(
  (v) => Object.keys(v).length > 0,
  { message: 'At least one field must be provided' },
);
export class UpdateTemplateDto extends createZodDto(UpdateTemplateSchema) {}
