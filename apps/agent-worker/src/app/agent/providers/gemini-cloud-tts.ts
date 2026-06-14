// SPDX-License-Identifier: Apache-2.0
import {
  AudioByteStream,
  type APIConnectOptions,
  shortuuid,
  tts,
} from '@livekit/agents';

const SAMPLE_RATE = 24_000;
const NUM_CHANNELS = 1;
const SYNTHESIZE_URL = 'https://texttospeech.googleapis.com/v1/text:synthesize';

export const DEFAULT_GEMINI_TTS_MODEL = 'gemini-2.5-flash-lite-preview-tts';
export const DEFAULT_GEMINI_TTS_VOICE = 'Aoede';
export const DEFAULT_GEMINI_TTS_PROMPT =
  'Say the following naturally, like a calm Ukrainian speaker on a phone call.';

export interface GeminiCloudTtsOptions {
  apiKey: string;
  languageCode: string;
  voiceName: string;
  modelName: string;
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
        throw new Error(
          `Gemini Cloud TTS HTTP ${res.status}: ${body.slice(0, 400)}`,
        );
      }
      const payload = (await res.json()) as { audioContent?: string };
      if (!payload.audioContent) {
        throw new Error('Gemini Cloud TTS response missing audioContent');
      }
      const nodeBuffer = Buffer.from(payload.audioContent, 'base64');
      const ab = new ArrayBuffer(nodeBuffer.length);
      new Uint8Array(ab).set(nodeBuffer);
      const requestId = shortuuid();
      const audioByteStream = new AudioByteStream(SAMPLE_RATE, NUM_CHANNELS);
      const frames = audioByteStream.write(ab);
      let lastFrame: (typeof frames)[number] | undefined;
      const flush = (final: boolean) => {
        if (lastFrame) {
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
      if (err instanceof Error && err.name === 'AbortError') return;
      throw err;
    } finally {
      this.queue.close();
    }
  }
}
