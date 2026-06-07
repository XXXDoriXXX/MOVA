import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import type {
  ConversationSearchRepository,
  SearchCriteria,
  SearchHit,
  SearchPage,
} from './conversation-search.repository';

interface SearchRow {
  conversationId: string;
  status: string;
  startedAt: Date;
  endedAt: Date | null;
  durationSeconds: number;
  templateId: string | null;
  templateName: string | null;
  matches: Array<{
    messageId: string;
    role: 'interlocutor' | 'ai' | 'user_typed';
    snippet: string;
    createdAt: string;
  }> | null;
  rank: string;
}

@Injectable()
export class PostgresConversationSearchRepository
  implements ConversationSearchRepository
{
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async search(criteria: SearchCriteria): Promise<SearchPage> {
    const probeLimit = criteria.limit + 1;
    const rows = await this.dataSource.query<SearchRow[]>(
      `
        WITH q AS (
          SELECT websearch_to_tsquery('simple', $1) AS query
        )
        SELECT
          c."id"                  AS "conversationId",
          c."status"              AS "status",
          c."startedAt"           AS "startedAt",
          c."endedAt"             AS "endedAt",
          c."durationSeconds"     AS "durationSeconds",
          c."templateId"          AS "templateId",
          t."name"                AS "templateName",
          (
            SELECT json_agg(match ORDER BY (match->>'createdAt'))
            FROM (
              SELECT json_build_object(
                'messageId', m."id",
                'role',      m."role",
                'snippet',   ts_headline(
                  'simple', m."content", q.query,
                  'StartSel=<mark>,StopSel=</mark>,MaxFragments=2,MinWords=4,MaxWords=18,ShortWord=2'
                ),
                'createdAt', m."createdAt"
              ) AS match
              FROM "messages" m
              CROSS JOIN q
              WHERE m."conversationId" = c."id"
                AND m."searchVector" @@ q.query
              ORDER BY ts_rank_cd(m."searchVector", q.query) DESC,
                       m."createdAt" ASC
              LIMIT 4
            ) ranked
          )                       AS "matches",
          (
            SELECT MAX(ts_rank_cd(m."searchVector", q.query))
            FROM "messages" m
            CROSS JOIN q
            WHERE m."conversationId" = c."id"
              AND m."searchVector" @@ q.query
          )                       AS "rank"
        FROM "conversations" c
        LEFT JOIN "templates" t ON t."id" = c."templateId"
        CROSS JOIN q
        WHERE c."userId" = $2
          AND c."deletedAt" IS NULL
          AND EXISTS (
            SELECT 1 FROM "messages" m
            WHERE m."conversationId" = c."id"
              AND m."searchVector" @@ q.query
          )
          AND ($3::timestamptz IS NULL OR c."startedAt" >= $3::timestamptz)
          AND ($4::timestamptz IS NULL OR c."startedAt" <= $4::timestamptz)
          AND ($5::uuid        IS NULL OR c."templateId" = $5::uuid)
        ORDER BY "rank" DESC NULLS LAST, c."startedAt" DESC
        LIMIT $6 OFFSET $7
      `,
      [
        criteria.query,
        criteria.userId,
        criteria.from ?? null,
        criteria.to ?? null,
        criteria.templateId ?? null,
        probeLimit,
        criteria.offset,
      ],
    );

    const hasMore = rows.length > criteria.limit;
    const page = hasMore ? rows.slice(0, criteria.limit) : rows;

    const items: SearchHit[] = page.map((row) => ({
      conversationId: row.conversationId,
      status: row.status,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      durationSeconds: row.durationSeconds,
      templateId: row.templateId,
      templateName: row.templateName,
      rank: Number(row.rank ?? 0),
      matches: (row.matches ?? []).map((m) => ({
        messageId: m.messageId,
        role: m.role,
        snippet: m.snippet,
        createdAt: new Date(m.createdAt),
      })),
    }));

    return { items, hasMore };
  }
}
