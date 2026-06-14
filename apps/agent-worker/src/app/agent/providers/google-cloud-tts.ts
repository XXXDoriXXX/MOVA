import {
  AudioByteStream,
  shortuuid,
  tts,
  type APIConnectOptions,
} from '@livekit/agents';

const SAMPLE_RATE = 24_000;
const NUM_CHANNELS = 1;
const SYNTHESIZE_URL =
  'https://texttospeech.googleapis.com/v1/text:synthesize';

export interface GoogleCloudTtsOptions {
  apiKey: string;
  languageCode: string;
  voiceName: string;
  pitch?: number;
  speakingRate?: number;
}

export class GoogleCloudTts extends tts.TTS {
  label = 'google-cloud.TTS';
  private readonly opts: Required<Omit<GoogleCloudTtsOptions, 'apiKey'>> &
    Pick<GoogleCloudTtsOptions, 'apiKey'>;

  constructor(opts: GoogleCloudTtsOptions) {
    super(SAMPLE_RATE, NUM_CHANNELS, { streaming: false });
    if (!opts.apiKey) {
      throw new Error(
        'GoogleCloudTts: apiKey is required (set GOOGLE_TTS_API_KEY).',
      );
    }
    this.opts = {
      apiKey: opts.apiKey,
      languageCode: opts.languageCode,
      voiceName: opts.voiceName,
      pitch: opts.pitch ?? 0,
      speakingRate: opts.speakingRate ?? 1,
    };
    void this.validateVoice().catch(() => {
    });
  }

  private async validateVoice(): Promise<void> {
    try {
      const url = `https://texttospeech.googleapis.com/v1/voices?languageCode=${encodeURIComponent(
        this.opts.languageCode,
      )}&key=${encodeURIComponent(this.opts.apiKey)}`;
      const res = await fetch(url);
      if (!res.ok) {
        process.stderr.write(
          `[GoogleCloudTts] voice-list probe got HTTP ${res.status}; skipping validation.\n`,
        );
        return;
      }
      const payload = (await res.json()) as {
        voices?: Array<{ name?: string }>;
      };
      const names = (payload.voices ?? [])
        .map((v) => v.name)
        .filter((n): n is string => !!n);
      if (!names.includes(this.opts.voiceName)) {
        const suggestions = names.slice(0, 5).join(', ');
        process.stderr.write(
          `[GoogleCloudTts] CONFIGURED VOICE NOT AVAILABLE: "${this.opts.voiceName}" not in Google Cloud TTS voice list for ${this.opts.languageCode}. ` +
            `Calls will fail. Try one of: ${suggestions || '(none returned)'}. ` +
            `Update GOOGLE_TTS_VOICE in .env (recreate the container — env_file is read at start).\n`,
        );
      }
    } catch (err) {
      process.stderr.write(
        `[GoogleCloudTts] voice-list probe failed: ${(err as Error).message}\n`,
      );
    }
  }

  synthesize(
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ): tts.ChunkedStream {
    return new GoogleCloudTtsChunkedStream(this, text, this.opts, connOptions, abortSignal);
  }

  stream(): tts.SynthesizeStream {
    throw new Error('Streaming synthesis not supported on GoogleCloudTts');
  }
}

class GoogleCloudTtsChunkedStream extends tts.ChunkedStream {
  label = 'google-cloud.ChunkedStream';
  private readonly opts: GoogleCloudTts['opts'];

  constructor(
    parent: GoogleCloudTts,
    text: string,
    opts: GoogleCloudTts['opts'],
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
            input: { text: this.inputText },
            voice: {
              languageCode: this.opts.languageCode,
              name: this.opts.voiceName,
            },
            audioConfig: {
              audioEncoding: 'LINEAR16',
              sampleRateHertz: SAMPLE_RATE,
              pitch: this.opts.pitch,
              speakingRate: this.opts.speakingRate,
            },
          }),
          signal: this.abortSignal,
        },
      );
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(
          `Google Cloud TTS HTTP ${res.status}: ${body.slice(0, 200)}`,
        );
      }
      const payload = (await res.json()) as { audioContent?: string };
      if (!payload.audioContent) {
        throw new Error('Google Cloud TTS response missing audioContent');
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
