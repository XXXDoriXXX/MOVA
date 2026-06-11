import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { ClientPlatform } from '@mova-back/shared-database';

const BreadcrumbSchema = z.object({
  ts: z.number().int().nonnegative().optional(),
  level: z.enum(['debug', 'info', 'warning', 'error']).optional(),
  category: z.string().max(60).optional(),
  message: z.string().max(500),
  data: z.record(z.string(), z.unknown()).optional(),
});

const ClientErrorEventSchema = z.object({
  name: z.string().trim().min(1).max(120),
  message: z.string().trim().min(1).max(4000),
  stack: z.string().max(20_000).optional(),
  fatal: z.boolean().default(false),
  platform: z.nativeEnum(ClientPlatform),
  appVersion: z.string().max(40).optional(),
  deviceModel: z.string().max(120).optional(),
  osVersion: z.string().max(60).optional(),
  screen: z.string().max(120).optional(),
  conversationId: z.string().uuid().optional(),
  breadcrumbs: z.array(BreadcrumbSchema).max(100).optional(),
  context: z.record(z.string(), z.unknown()).optional(),
  clientCreatedAt: z.string().datetime().optional(),
});

export type ClientErrorEvent = z.infer<typeof ClientErrorEventSchema>;

export const ReportClientErrorsSchema = z.object({
  events: z.array(ClientErrorEventSchema).min(1).max(20),
});

export class ReportClientErrorsDto extends createZodDto(ReportClientErrorsSchema) {}
