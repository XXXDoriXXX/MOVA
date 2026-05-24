import {
  AudioByteStream,
  shortuuid,
  tts,
  type APIConnectOptions,
} from '@livekit/agents';

/**
 * Google Cloud Text-to-Speech adapter for LiveKit Agents JS.
 *
 * Why custom (not via @livekit/agents-plugin-google):
 *   That plugin only wraps Gemini's generative TTS (mythological voice
 *   names like "Kore"). Cloud TTS — the classic Wavenet/Standard/Neural2
 *   voices selected by language code (`uk-UA-Wavenet-A`) — has no
 *   first-party LiveKit plugin, so we hit the REST API directly.
 *
 * Why Cloud TTS Wavenet for MOVA:
 *   - UA voices: `uk-UA-Wavenet-A/B/C/D` — solid pronunciation, no LLM
 *     hallucinations, no breathing artefacts, deterministic.
 *   - Cost: \$16 per 1M characters (Wavenet) — about 19× cheaper than
 *     ElevenLabs Multilingual.
 *   - Auth: a single Google Cloud API key (\`GOOGLE_TTS_API_KEY\`) on the
 *     project where the Cloud TTS API is enabled + billing active. No
 *     service-account JSON files to mount.
 *
 * Wire format:
 *   POST https://texttospeech.googleapis.com/v1/text:synthesize?key=K
 *     { input: {text}, voice: {languageCode, name},
 *       audioConfig: {audioEncoding: 'LINEAR16', sampleRateHertz: 24000} }
 *   Response: { audioContent: <base64 raw PCM little-endian> }
 *
 * Streaming: the REST endpoint is non-streaming. We satisfy LiveKit's
 * abstract `stream()` by reusing TTS.StreamAdapter-equivalent logic
 * upstream, but for the proxy-call use case where utterances are short
 * sentences (≤2s of audio), the chunked one-shot synthesis is fine —
 * the agent says full sentences anyway, not token-by-token streams.
 */

const SAMPLE_RATE = 24_000;
const NUM_CHANNELS = 1;
const SYNTHESIZE_URL =
  'https://texttospeech.googleapis.com/v1/text:synthesize';

export interface GoogleCloudTtsOptions {
  apiKey: string;
  /** BCP-47 language code; must match the `name`'s prefix. */
  languageCode: string;
  /** Full voice id from Cloud TTS, e.g. "uk-UA-Wavenet-A". */
  voiceName: string;
  /** -20.0 to +20.0; 0.0 is default. Most UA voices sound natural at 0. */
  pitch?: number;
  /** 0.25 to 4.0; 1.0 is default. */
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
    // Fire-and-forget validation. The synthesize HTTP call would already
    // surface a 400 "Voice X does not exist", but it surfaces inside the
    // StreamAdapter → EventEmitter chain (hard to catch cleanly, and we
    // discover it only when the first turn ends in silence). Probing the
    // /voices endpoint at construction means the operator sees a clear
    // error in the agent-worker log the moment the session is created,
    // BEFORE the SIP leg has had time to start ringing. We deliberately
    // don't await — failure to validate shouldn't block call setup if
    // Google's voices endpoint blips; the real synth call will retry.
    void this.validateVoice().catch(() => {
      /* swallowed — logged inside */
    });
  }

  private async validateVoice(): Promise<void> {
    try {
      const url = `https://texttospeech.googleapis.com/v1/voices?languageCode=${encodeURIComponent(
        this.opts.languageCode,
      )}&key=${encodeURIComponent(this.opts.apiKey)}`;
      const res = await fetch(url);
      if (!res.ok) {
        // Network / auth issue — log a hint but don't fail. The first
        // synthesize() will surface a more specific error if relevant.
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
    // We don't implement true streaming — Cloud TTS REST returns the whole
    // utterance in one shot. The agent framework only requests `.stream()`
    // when STT/LLM produces token-level streams; our usage path uses
    // `.synthesize(fullSentence)` exclusively. If a code path ever needs
    // it, wrap with tts.StreamAdapter(this, sentenceTokenizer) instead of
    // touching this class.
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
      // AudioByteStream.write expects an ArrayBuffer; Buffer's underlying
      // .buffer can be SharedArrayBuffer in some runtimes, and may be
      // wider than the actual data when Buffer was sliced. Copy into a
      // tightly-sized ArrayBuffer to satisfy the strict signature.
      const ab = new ArrayBuffer(nodeBuffer.length);
      new Uint8Array(ab).set(nodeBuffer);
      const requestId = shortuuid();
      const audioByteStream = new AudioByteStream(SAMPLE_RATE, NUM_CHANNELS);
      // We get the whole utterance at once; iterate the produced frames
      // and emit them so the AgentSession can pace playback. Matches the
      // OpenAI plugin's chunking pattern verbatim — keeps the "last
      // frame carries final=true" contract intact.
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
