import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  Conversation,
  CostRate,
  Message,
  MessageRole,
} from '@mova-back/shared-database';

import {
  computeConversationCost,
  CostBreakdown,
  RateMap,
  UsageInput,
} from './cost-engine';

// Estimation constants used ONLY until Phase 2b captures real provider metrics.
// English averages ≈ 4 chars/token; Ukrainian runs a touch higher but this is a
// cost estimate, not an invoice. Input ≈ 3× output because each turn re-sends the
// system prompt + transcript history. Speech ≈ 15 chars/sec of audio.
const CHARS_PER_OUTPUT_TOKEN = 4;
const INPUT_TO_OUTPUT_TOKEN_RATIO = 3;
const SPEECH_CHARS_PER_SECOND = 15;

export interface ConversationCostResult {
  conversationId: string;
  durationSeconds: number;
  breakdown: CostBreakdown;
  usage: UsageInput;
}

@Injectable()
export class ConversationCostService {
  constructor(
    @InjectRepository(Conversation)
    private readonly conversations: Repository<Conversation>,
    @InjectRepository(Message)
    private readonly messages: Repository<Message>,
    @InjectRepository(CostRate)
    private readonly rates: Repository<CostRate>,
  ) {}

  async listRates(): Promise<CostRate[]> {
    return this.rates.find({ order: { key: 'ASC' } });
  }

  /** Admin override of a single rate. Returns the updated row. */
  async updateRate(
    key: string,
    rate: number,
    updatedBy: string | null,
  ): Promise<CostRate> {
    const row = await this.rates.findOne({ where: { key } });
    if (!row) throw new NotFoundException(`Unknown cost rate: ${key}`);
    row.rate = rate.toString();
    row.updatedBy = updatedBy;
    return this.rates.save(row);
  }

  async getConversationCost(
    conversationId: string,
  ): Promise<ConversationCostResult> {
    const conversation = await this.conversations.findOne({
      where: { id: conversationId },
    });
    if (!conversation)
      throw new NotFoundException(`Conversation not found: ${conversationId}`);

    const messages = await this.messages.find({
      where: { conversationId },
      select: ['role', 'content', 'ttsProvider', 'llmProvider'],
    });

    const usage = this.buildUsage(conversation, messages);
    const rateMap = await this.loadRates();
    const breakdown = computeConversationCost(usage, rateMap);

    return {
      conversationId,
      durationSeconds: conversation.durationSeconds,
      breakdown,
      usage,
    };
  }

  private buildUsage(
    conversation: Pick<
      Conversation,
      'durationSeconds' | 'llmInputTokens' | 'llmOutputTokens'
    >,
    messages: Pick<Message, 'role' | 'content' | 'ttsProvider' | 'llmProvider'>[],
  ): UsageInput {
    const ttsChars = new Map<string, number>();
    const llmOutChars = new Map<string, number>();
    let sttChars = 0;

    for (const m of messages) {
      const len = m.content?.length ?? 0;
      const spoken =
        m.role === MessageRole.AI || m.role === MessageRole.USER_TYPED;
      if (spoken && m.ttsProvider) {
        ttsChars.set(m.ttsProvider, (ttsChars.get(m.ttsProvider) ?? 0) + len);
      }
      if (m.role === MessageRole.AI && m.llmProvider) {
        llmOutChars.set(
          m.llmProvider,
          (llmOutChars.get(m.llmProvider) ?? 0) + len,
        );
      }
      if (m.role === MessageRole.INTERLOCUTOR) sttChars += len;
    }

    const tts = [...ttsChars.entries()].map(([provider, chars]) => ({
      provider,
      chars,
    }));

    return {
      telephonySeconds: Math.max(0, conversation.durationSeconds),
      tts,
      llm: this.buildLlmUsage(conversation, llmOutChars),
      stt: {
        provider: 'deepgram',
        seconds: sttChars / SPEECH_CHARS_PER_SECOND,
        estimated: true,
      },
    };
  }

  /**
   * Prefer REAL measured tokens (agent llm.usage → conversation columns); they
   * are a single total across providers, attributed to the dominant LLM provider
   * for rate lookup. Fall back to estimating per provider from message text on
   * pre-feature conversations (token columns still 0).
   */
  private buildLlmUsage(
    conversation: Pick<Conversation, 'llmInputTokens' | 'llmOutputTokens'>,
    llmOutChars: Map<string, number>,
  ): UsageInput['llm'] {
    const measured =
      conversation.llmInputTokens > 0 || conversation.llmOutputTokens > 0;
    if (measured) {
      let dominant = 'groq';
      let max = -1;
      for (const [provider, chars] of llmOutChars) {
        if (chars > max) {
          max = chars;
          dominant = provider;
        }
      }
      return [
        {
          provider: dominant,
          inputTokens: conversation.llmInputTokens,
          outputTokens: conversation.llmOutputTokens,
          estimated: false,
        },
      ];
    }
    return [...llmOutChars.entries()].map(([provider, chars]) => {
      const outputTokens = Math.round(chars / CHARS_PER_OUTPUT_TOKEN);
      return {
        provider,
        outputTokens,
        inputTokens: outputTokens * INPUT_TO_OUTPUT_TOKEN_RATIO,
        estimated: true,
      };
    });
  }

  private async loadRates(): Promise<RateMap> {
    const rows = await this.rates.find();
    return new Map(
      rows.map((r) => [
        r.key,
        { rate: Number(r.rate), rateUnit: r.rateUnit, label: r.label },
      ]),
    );
  }
}
