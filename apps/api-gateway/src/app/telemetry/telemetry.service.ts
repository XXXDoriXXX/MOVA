import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ClientErrorReport } from '@mova-back/shared-database';

import type { ClientErrorEvent } from './dto/telemetry.schemas';

export interface ClientErrorQuery {
  userId?: string;
  name?: string;
  fatal?: boolean;
  limit?: number;
  cursor?: string;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

@Injectable()
export class TelemetryService {
  private readonly logger = new Logger(TelemetryService.name);

  constructor(
    @InjectRepository(ClientErrorReport)
    private readonly reports: Repository<ClientErrorReport>,
  ) {}

  async record(
    userId: string | null,
    events: ClientErrorEvent[],
  ): Promise<number> {
    const rows = events.map((e) =>
      this.reports.create({
        userId,
        platform: e.platform,
        appVersion: e.appVersion ?? null,
        deviceModel: e.deviceModel ?? null,
        osVersion: e.osVersion ?? null,
        fatal: e.fatal,
        name: e.name,
        message: e.message,
        stack: e.stack ?? null,
        screen: e.screen ?? null,
        context: {
          ...(e.conversationId ? { conversationId: e.conversationId } : {}),
          ...(e.breadcrumbs ? { breadcrumbs: e.breadcrumbs } : {}),
          ...(e.context ?? {}),
        },
        clientCreatedAt: e.clientCreatedAt ? new Date(e.clientCreatedAt) : null,
      }),
    );
    await this.reports.save(rows);

    const fatalCount = events.filter((e) => e.fatal).length;
    this.logger.log({
      msg: 'telemetry.clientErrors.stored',
      evt: 'telemetry.clientErrors.stored',
      userId,
      count: rows.length,
      fatal: fatalCount,
      names: [...new Set(events.map((e) => e.name))].slice(0, 5),
    });
    return rows.length;
  }

  async list(query: ClientErrorQuery): Promise<ClientErrorReport[]> {
    const limit = Math.min(query.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const qb = this.reports
      .createQueryBuilder('r')
      .orderBy('r."createdAt"', 'DESC')
      .limit(limit);
    if (query.userId) qb.andWhere('r."userId" = :userId', { userId: query.userId });
    if (query.name) qb.andWhere('r."name" = :name', { name: query.name });
    if (typeof query.fatal === 'boolean') {
      qb.andWhere('r."fatal" = :fatal', { fatal: query.fatal });
    }
    if (query.cursor) {
      qb.andWhere('r."createdAt" < :cursor', { cursor: new Date(query.cursor) });
    }
    return qb.getMany();
  }
}
