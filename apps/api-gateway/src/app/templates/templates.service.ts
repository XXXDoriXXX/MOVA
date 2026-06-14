import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';

import { LakeraGuardService } from '@mova-back/shared-auth';
import { Template, UserLanguage } from '@mova-back/shared-database';

import type { CreateTemplateDto, UpdateTemplateDto } from './dto/template.schemas';

const LAKERA_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

@Injectable()
export class TemplatesService {
  private readonly logger = new Logger(TemplatesService.name);

  constructor(
    @InjectRepository(Template)
    private readonly repo: Repository<Template>,
    private readonly lakera: LakeraGuardService,
  ) {}

  async listVisible(userId: string, language: UserLanguage): Promise<Template[]> {
    const rows = await this.repo
      .createQueryBuilder('t')
      .where('t."deletedAt" IS NULL')
      .andWhere(
        '(t."userId" = :userId OR (t."isSystem" = true AND t."userId" IS NULL))',
        { userId },
      )
      .orderBy('t."isDefault"', 'DESC')
      .addOrderBy('t."createdAt"', 'DESC')
      .getMany();
    return this.sortByLanguagePreference(rows, language);
  }

  async findOneForUser(userId: string, templateId: string): Promise<Template> {
    const template = await this.repo.findOne({
      where: { id: templateId, deletedAt: IsNull() },
    });
    if (!template) {
      throw new NotFoundException('Template not found');
    }
    if (!this.canRead(template, userId)) {
      throw new NotFoundException('Template not found');
    }
    return template;
  }

  async create(userId: string, dto: CreateTemplateDto): Promise<Template> {
    await this.assertPromptSafe(dto.systemPrompt);

    const entity = this.repo.create({
      userId,
      name: dto.name,
      description: dto.description,
      systemPrompt: dto.systemPrompt,
      language: dto.language,
      defaultVoice: dto.defaultVoice ?? null,
      defaultLlmProvider: dto.defaultLlmProvider ?? null,
      defaultLlmModel: dto.defaultLlmModel ?? null,
      defaultTtsProvider: dto.defaultTtsProvider ?? null,
      isSystem: false,
      isDefault: false,
    });
    return this.repo.save(entity);
  }

  async update(
    userId: string,
    templateId: string,
    dto: UpdateTemplateDto,
  ): Promise<Template> {
    const existing = await this.findOneForUser(userId, templateId);
    if (!this.canModify(existing, userId)) {
      throw new ForbiddenException('System templates cannot be modified');
    }

    if (dto.systemPrompt && dto.systemPrompt !== existing.systemPrompt) {
      await this.assertPromptSafe(dto.systemPrompt);
    }

    Object.assign(existing, {
      ...(dto.name !== undefined && { name: dto.name }),
      ...(dto.description !== undefined && { description: dto.description }),
      ...(dto.systemPrompt !== undefined && { systemPrompt: dto.systemPrompt }),
      ...(dto.language !== undefined && { language: dto.language }),
      ...(dto.defaultVoice !== undefined && { defaultVoice: dto.defaultVoice }),
      ...(dto.defaultLlmProvider !== undefined && {
        defaultLlmProvider: dto.defaultLlmProvider,
      }),
      ...(dto.defaultLlmModel !== undefined && { defaultLlmModel: dto.defaultLlmModel }),
      ...(dto.defaultTtsProvider !== undefined && {
        defaultTtsProvider: dto.defaultTtsProvider,
      }),
    });

    return this.repo.save(existing);
  }

  async softDelete(userId: string, templateId: string): Promise<void> {
    const existing = await this.findOneForUser(userId, templateId);
    if (!this.canModify(existing, userId)) {
      throw new ForbiddenException('System templates cannot be deleted');
    }
    await this.repo.softDelete({ id: templateId });
  }

  async duplicate(userId: string, templateId: string): Promise<Template> {
    const source = await this.findOneForUser(userId, templateId);
    await this.assertPromptSafe(source.systemPrompt);

    const copy = this.repo.create({
      userId,
      name: `${source.name} (копія)`.slice(0, 80),
      description: source.description,
      systemPrompt: source.systemPrompt,
      language: source.language,
      defaultVoice: source.defaultVoice,
      defaultLlmProvider: source.defaultLlmProvider,
      defaultLlmModel: source.defaultLlmModel,
      defaultTtsProvider: source.defaultTtsProvider,
      isSystem: false,
      isDefault: false,
    });
    return this.repo.save(copy);
  }

  async setDefault(userId: string, templateId: string): Promise<Template> {
    const target = await this.findOneForUser(userId, templateId);
    if (target.isSystem) {
      throw new ForbiddenException(
        'System templates cannot be set as default. Duplicate first.',
      );
    }

    return this.repo.manager.transaction(async (tx) => {
      await tx.update(Template, { userId, isDefault: true }, { isDefault: false });
      target.isDefault = true;
      return tx.save(target);
    });
  }

  async setDefaultStyle(
    userId: string,
    templateId: string,
    styleId: string | null,
  ): Promise<Template> {
    const target = await this.findOneForUser(userId, templateId);
    if (!this.canModify(target, userId)) {
      throw new ForbiddenException('System templates cannot be modified');
    }
    target.defaultStyleId = styleId;
    return this.repo.save(target);
  }

  async resolveDefaultForUser(
    userId: string,
    language: UserLanguage,
  ): Promise<Template | null> {
    const userDefault = await this.repo.findOne({
      where: { userId, isDefault: true, deletedAt: IsNull() },
    });
    if (userDefault) return userDefault;

    return (
      (await this.repo.findOne({
        where: { isSystem: true, language, deletedAt: IsNull() },
        order: { createdAt: 'ASC' },
      })) ??
      (await this.repo.findOne({
        where: { isSystem: true, deletedAt: IsNull() },
        order: { createdAt: 'ASC' },
      }))
    );
  }

  private canRead(t: Template, userId: string): boolean {
    return t.isSystem || t.userId === userId;
  }

  private canModify(t: Template, userId: string): boolean {
    return !t.isSystem && t.userId === userId;
  }

  private async assertPromptSafe(text: string): Promise<void> {
    const result = await this.lakera.check(text, { cacheTtlMs: LAKERA_CACHE_TTL_MS });
    if (result.safe) return;

    this.logger.warn(
      `Blocked template systemPrompt by Lakera: reasons=${result.reasons.join(',')}`,
    );
    throw new HttpException(
      {
        error: {
          code: 'PROMPT_INJECTION_DETECTED',
          message:
            'Системний промпт містить підозрілий вміст. Перефразуйте та спробуйте знову.',
          details: { reasons: result.reasons },
        },
      },
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }

  private sortByLanguagePreference(rows: Template[], language: UserLanguage): Template[] {
    const own: Template[] = [];
    const systemSameLang: Template[] = [];
    const systemOther: Template[] = [];
    for (const t of rows) {
      if (!t.isSystem) own.push(t);
      else if (t.language === language) systemSameLang.push(t);
      else systemOther.push(t);
    }
    return [...own, ...systemSameLang, ...systemOther];
  }
}

