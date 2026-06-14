import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  UserStyleProfile,
  type StyleExemplar,
} from '@mova-back/shared-database';

export const STYLE_WARMUP_MIN_SAMPLES = 3;

const STYLE_PROMPT_BYTES_CAP = 1_200;

@Injectable()
export class UserStyleReaderService {
  private readonly logger = new Logger(UserStyleReaderService.name);

  constructor(
    @InjectRepository(UserStyleProfile)
    private readonly profiles: Repository<UserStyleProfile>,
  ) {}

  async buildPromptAddendum(userId: string | null | undefined): Promise<string | null> {
    if (!userId) return null;
    let row: UserStyleProfile | null;
    try {
      row = await this.profiles.findOne({ where: { userId } });
    } catch (err) {
      this.logger.debug(
        `Style profile read failed for user=${userId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
    if (!row) return null;
    if (row.sampleCount < STYLE_WARMUP_MIN_SAMPLES) return null;
    if (!row.exemplarMessages || row.exemplarMessages.length === 0) return null;

    return renderStylePrompt(row.exemplarMessages, {
      avgLength: row.avgMessageLength,
      sampleCount: row.sampleCount,
    });
  }
}

export function renderStylePrompt(
  exemplars: StyleExemplar[],
  stats: { avgLength: number; sampleCount: number },
): string {
  const sorted = [...exemplars].sort((a, b) => {
    const ta = Date.parse(a.createdAt) || 0;
    const tb = Date.parse(b.createdAt) || 0;
    return tb - ta;
  });

  const picked: string[] = [];
  let bytes = 0;
  for (const ex of sorted) {
    const line = `- "${ex.content.replace(/"/g, '\\"')}"`;
    const lineBytes = Buffer.byteLength(line, 'utf8');
    if (picked.length > 0 && bytes + lineBytes > STYLE_PROMPT_BYTES_CAP) break;
    picked.push(line);
    bytes += lineBytes;
  }

  return [
    `--- User's writing style (mimic this in suggestions) ---`,
    `Sample size: ${stats.sampleCount} messages, average length ~${stats.avgLength} chars.`,
    `Examples of how THIS user actually writes:`,
    ...picked,
    `Match this user's dialect, slang, punctuation habits, sentence length,`,
    `and formality level. If they use regional words or rare phrasings,`,
    `prefer those over textbook synonyms. Do NOT translate their dialect to`,
    `standard form. The goal is suggestions that sound like the user wrote them.`,
  ].join('\n');
}
