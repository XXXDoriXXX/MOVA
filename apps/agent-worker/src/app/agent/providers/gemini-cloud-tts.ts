// SPDX-License-Identifier: Apache-2.0
import {
  AudioByteStream,
  type APIConnectOptions,
  shortuuid,
  tts,
} from '@livekit/agents';

/**
 * Cloud Text-to-Speech "Gemini-TTS" provider.
 *
 * This is a SECOND google provider, intentionally separate from
 * `GoogleCloudTts` (which handles classic Wavenet / Chirp3-HD voices).
 *
 * Why two classes instead of one with a flag:
 *   1. Different request body shape. Gemini-TTS adds `input.prompt` (a
 *      natural-language style cue: "say this warmly", "speak slowly") and
 *      `voice.model_name` (the gemini-*-tts model id). Voice names are
 *      single-token speakers (`Aoede`, `Kore`, `Charon`) WITHOUT a locale
 *      prefix — the model infers the language from `voice.languageCode`
 *      and the text content.
 *   2. Different access path. Gemini-TTS routes via Vertex AI under the
 *      hood (Cloud TTS proxies it), so the GCP project needs the
 *      `aiplatform.googleapis.com` API enabled. If it isn't, the API
 *      returns 403 with a "click to enable" link — that error surface
 *      is meaningless for the classic Cloud TTS path and would confuse
 *      operators if mixed in.
 *
 * Why route via Cloud TTS instead of `@livekit/agents-plugin-google`
 * (`google.beta.TTS`):
 *   The plugin calls Generative Language API (ai.google.dev,
 *   `models.generateContentStream`). That endpoint serves
 *   `gemini-2.5-flash-preview-tts` and `gemini-2.5-pro-preview-tts` but
 *   does NOT serve `gemini-2.5-flash-lite-preview-tts` — which is what
 *   we want as primary because it's the cheapest in the family. Cloud
 *   TTS is the only path to flash-lite.
 *
 * Request shape we send:
 *   POST https://texttospeech.googleapis.com/v1/text:synthesize?key=…
 *   {
 *     "input":     { "prompt": "<style cue>", "text": "<actual text>" },
 *     "voice":     { "languageCode": "uk-UA", "name": "Aoede",
 *                    "model_name": "gemini-2.5-flash-lite-preview-tts" },
 *     "audioConfig": { "audioEncoding": "LINEAR16", "sampleRateHertz": 24000 }
 *   }
 *
 * The response is the same `{ audioContent: <base64> }` shape as the
 * classic Cloud TTS endpoint — we reuse the chunking pattern from
 * `GoogleCloudTts` so the produced frames flow through AudioByteStream
 * identically and the agent pipeline doesn't need to know which provider
 * served the bytes.
 */

const SAMPLE_RATE = 24_000;
const NUM_CHANNELS = 1;
const SYNTHESIZE_URL = 'https://texttospeech.googleapis.com/v1/text:synthesize';

/** Default Gemini-TTS model. flash-lite-preview-tts is the cheapest in the
 *  family and quality-matched to the use case (proxy call, conversational
 *  Ukrainian). Override via `GEMINI_TTS_MODEL` env. */
export const DEFAULT_GEMINI_TTS_MODEL = 'gemini-2.5-flash-lite-preview-tts';
/** Default speaker. Aoede = female, warm, natural cadence — works well on
 *  uk-UA according to Google's own samples. Override via `GEMINI_TTS_VOICE`. */
export const DEFAULT_GEMINI_TTS_VOICE = 'Aoede';
/** Default prompt — the style cue prefixed to every utterance. Kept generic
 *  on purpose so it doesn't fight the LLM's own tone. */
export const DEFAULT_GEMINI_TTS_PROMPT =
  'Say the following naturally, like a calm Ukrainian speaker on a phone call.';

export interface GeminiCloudTtsOptions {
  apiKey: string;
  /** BCP-47, e.g. "uk-UA". Drives the language interpretation hint. */
  languageCode: string;
  /** Speaker name without locale prefix, e.g. "Aoede". */
  voiceName: string;
  /** Full Gemini-TTS model id, e.g. "gemini-2.5-flash-lite-preview-tts". */
  modelName: string;
  /** Natural-language style cue. Sent as `input.prompt`. */
  prompt?: string;
}

export class GeminiCloudTts extends tts.TTS {
  label = 'gemini-cloud.TTS';
  private readonly opts: Required<Omit<GeminiCloudTtsOptions, 'apiKey'>> &
    Pick<GeminiCloudTtsOptions, 'apiKey'>;

  constructor(opts: GeminiCloudTtsOptions) {
    super(SAMPLE_RATE, NUM_CHANNELS, { streaming: false });
    if (!opts.apiKey) {
      throw new Error(
        'GeminiCloudTts: apiKey is required. Set GOOGLE_TTS_API_KEY (Cloud Console key, NOT AI Studio).',
      );
    }
    this.opts = {
      apiKey: opts.apiKey,
      languageCode: opts.languageCode,
      voiceName: opts.voiceName,
      modelName: opts.modelName,
      prompt: opts.prompt ?? DEFAULT_GEMINI_TTS_PROMPT,
    };
  }

  synthesize(
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ): tts.ChunkedStream {
    return new GeminiCloudTtsChunkedStream(this, text, this.opts, connOptions, abortSignal);
  }

  stream(): tts.SynthesizeStream {
    throw new Error('Streaming synthesis not supported on GeminiCloudTts');
  }
}

class GeminiCloudTtsChunkedStream extends tts.ChunkedStream {
  label = 'gemini-cloud.ChunkedStream';
  private readonly opts: GeminiCloudTts['opts'];

  constructor(
    parent: GeminiCloudTts,
    text: string,
    opts: GeminiCloudTts['opts'],
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ) {
    super(text, parent, connOptions, abortSignal);
    this.opts = opts;
  }

  protected override async run(): Promise<void> {
    try {
      const res = await fetch(
        `${SYNTHESIZE_URL}?key=${encodeURIComponent(this.opts.apiKey)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            input: { prompt: this.opts.prompt, text: this.inputText },
            voice: {
              languageCode: this.opts.languageCode,
              name: this.opts.voiceName,
              model_name: this.opts.modelName,
            },
            audioConfig: {
              audioEncoding: 'LINEAR16',
              sampleRateHertz: SAMPLE_RATE,
            },
          }),
          signal: this.abortSignal,
        },
      );
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        // 403 from this endpoint usually means the GCP project hasn't
        // enabled aiplatform.googleapis.com. Surface the actionable
        // link from the error body so the operator sees it directly.
        throw new Error(
          `Gemini Cloud TTS HTTP ${res.status}: ${body.slice(0, 400)}`,
        );
      }
      const payload = (await res.json()) as { audioContent?: string };
      if (!payload.audioContent) {
        throw new Error('Gemini Cloud TTS response missing audioContent');
      }
      const nodeBuffer = Buffer.from(payload.audioContent, 'base64');
      // Match GoogleCloudTts: copy into a tightly-sized ArrayBuffer for
      // AudioByteStream — Buffer's underlying .buffer may be wider than
      // the actual data on some runtimes.
      const ab = new ArrayBuffer(nodeBuffer.length);
      new Uint8Array(ab).set(nodeBuffer);
      const requestId = shortuuid();
      const audioByteStream = new AudioByteStream(SAMPLE_RATE, NUM_CHANNELS);
      const frames = audioByteStream.write(ab);
      let lastFrame: (typeof frames)[number] | undefined;
      const flush = (final: boolean) => {
        if (lastFrame) {
          // segmentId must match requestId for single-utterance chunked
          // streams — mirrors GoogleCloudTts. Without it, agent pipeline
          // can't correlate the audio back to the speech handle.
          this.queue.put({
            requestId,
            segmentId: requestId,
            frame: lastFrame,
            final,
          });
          lastFrame = undefined;
        }
      };
      for (const frame of frames) {
        flush(false);
        lastFrame = frame;
      }
      flush(true);
    } catch (err) {
      // Abort during interruption is expected control flow — let the
      // agent pipeline handle it without surfacing as a TTS error.
      if (err instanceof Error && err.name === 'AbortError') return;
      throw err;
    } finally {
      this.queue.close();
    }
  }
}
