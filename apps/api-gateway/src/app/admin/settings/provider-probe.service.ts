import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

import { reportError } from '@mova-back/shared-config';

import type { KnownSetting } from './known-settings';

export interface ProbeResult {
  ok: boolean;
  /** HTTP status code from the upstream, when relevant. */
  status?: number;
  /** Short message rendered next to the field in the admin UI. */
  message: string;
}

/**
 * Cheap auth-only HTTP probes per provider. We pick the lightest endpoint
 * the vendor exposes that requires the API key — typically `/v1/models` or
 * `/v1/voices` — so a probe doesn't bill us for tokens. Each probe has a
 * 6s hard timeout: real upstream outages should return fast as "down", not
 * pin the admin UI's spinner.
 *
 * Returned `ok` reflects "the key is accepted by the upstream", not "the
 * upstream is generally healthy". A 200 with empty body is fine; a 401 or
 * 403 means the key is wrong; 5xx means upstream's having a bad day but
 * the key is probably fine — we still report `ok=false` so the admin
 * doesn't trust an unverifiable key. The UI lets them save anyway.
 */
@Injectable()
export class ProviderProbeService {
  private readonly logger = new Logger(ProviderProbeService.name);
  private readonly client = axios.create({
    timeout: 6_000,
    validateStatus: () => true,
  });

  async probe(setting: KnownSetting, value: string): Promise<ProbeResult> {
    if (setting.probe === 'none') {
      // No live endpoint — best we can offer is a non-empty + length check.
      return value.length >= setting.minLength
        ? { ok: true, message: `Збережено. Перевірка довжини пройшла.` }
        : { ok: false, message: `Закоротко: мінімум ${setting.minLength} символів.` };
    }
    try {
      switch (setting.key) {
        case 'OPENAI_API_KEY':
          return await this.probeBearer('https://api.openai.com/v1/models', value);
        case 'GROQ_API_KEY':
          return await this.probeBearer(
            'https://api.groq.com/openai/v1/models',
            value,
          );
        case 'ANTHROPIC_API_KEY':
          return await this.probeAnthropic(value);
        case 'GEMINI_API_KEY':
          return await this.probeGemini(value);
        case 'DEEPGRAM_API_KEY':
          return await this.probeDeepgram(value);
        case 'ELEVENLABS_API_KEY':
          return await this.probeElevenLabs(value);
        default:
          return { ok: true, message: 'Збережено (нема upstream-проби для цього ключа).' };
      }
    } catch (err) {
      reportError(this.logger, `Probe threw for ${setting.key}`, err);
      return {
        ok: false,
        message: `Помилка під час перевірки: ${
          err instanceof Error ? err.message : 'unknown'
        }`,
      };
    }
  }

  // ── Per-provider probes ────────────────────────────

  private async probeBearer(url: string, key: string): Promise<ProbeResult> {
    const res = await this.client.get(url, {
      headers: { authorization: `Bearer ${key}` },
    });
    return this.interpret(res.status);
  }

  private async probeAnthropic(key: string): Promise<ProbeResult> {
    const res = await this.client.get('https://api.anthropic.com/v1/models', {
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
    });
    return this.interpret(res.status);
  }

  private async probeGemini(key: string): Promise<ProbeResult> {
    const res = await this.client.get(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`,
    );
    return this.interpret(res.status);
  }

  private async probeDeepgram(key: string): Promise<ProbeResult> {
    const res = await this.client.get('https://api.deepgram.com/v1/projects', {
      headers: { authorization: `Token ${key}` },
    });
    return this.interpret(res.status);
  }

  private async probeElevenLabs(key: string): Promise<ProbeResult> {
    const res = await this.client.get('https://api.elevenlabs.io/v1/voices', {
      headers: { 'xi-api-key': key },
    });
    return this.interpret(res.status);
  }

  private interpret(status: number): ProbeResult {
    if (status >= 200 && status < 300) {
      return { ok: true, status, message: `Ключ прийнято upstream'ом (HTTP ${status}).` };
    }
    if (status === 401 || status === 403) {
      return {
        ok: false,
        status,
        message: `Ключ відхилено: HTTP ${status} (auth). Перевір значення.`,
      };
    }
    if (status === 429) {
      return {
        ok: false,
        status,
        message: `Rate-limited (HTTP 429). Ключ може бути правильним — спробуй пізніше.`,
      };
    }
    return {
      ok: false,
      status,
      message: `Несподівана відповідь HTTP ${status}.`,
    };
  }
}
