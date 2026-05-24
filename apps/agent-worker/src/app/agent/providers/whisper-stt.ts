// SPDX-License-Identifier: Apache-2.0
import { Logger } from '@nestjs/common';
import {
  AudioByteStream,
  type APIConnectOptions,
  type AudioBuffer,
  log as livekitLog,
  mergeFrames,
  stt,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';

/**
 * OpenAI Whisper STT provider for LiveKit Agents.
 *
 * Mode: BATCHED. Whisper's `/v1/audio/transcriptions` endpoint
 * takes a complete audio file (WAV/MP3/etc.) and returns the full
 * transcript. There's no token-by-token streaming on this endpoint,
 * so we accumulate audio between flush points and submit the
 * accumulated chunk.
 *
 * Flush triggers:
 *   1. `flush()` called from the framework (typical: VAD detected
 *      end-of-utterance via the LiveKit Agents pipeline upstream).
 *   2. Soft cap on chunk size — 30s of audio at 16kHz mono = ~960KB
 *      PCM. Past that we force-submit to keep latency bounded even
 *      if upstream VAD goes quiet.
 *
 * Trade-off vs Deepgram:
 *   - Latency: ~600-1500ms after end-of-utterance vs Deepgram's
 *     ~200ms partials. The interlocutor pauses → silence → transcript.
 *     Acceptable as a FALLBACK during a Deepgram outage; not ideal
 *     as primary.
 *   - Cost: $0.006/min (Whisper) vs ~$0.0085/min (Deepgram nova-3).
 *   - No `transcript.partial` events — the agent's response watchdog
 *     in agent-call.handler may need a longer first-frame budget when
 *     Whisper is active. Hard-coded in case TTS_SAY_TIMEOUT_MS for now.
 *
 * For TRUE streaming Whisper, see OpenAI's gpt-4o-realtime-preview
 * WebSocket API — different SDK, different shape, not yet wired here.
 *
 * Status: SCAFFOLD — compiles + integrates into SttFactory under
 * `STT_FALLBACK_PROVIDER=openai`, but the WAV encoding step uses
 * AudioByteStream which we haven't smoke-tested end-to-end. First
 * caller should run a real call with Deepgram key intentionally
 * broken to validate the cold-swap path actually transcribes.
 */

const WHISPER_URL = 'https://api.openai.com/v1/audio/transcriptions';
const DEFAULT_MODEL = 'whisper-1';
const SAMPLE_RATE = 16_000; // Whisper resamples internally; 16k is sweet spot
const NUM_CHANNELS = 1;
/** Cap to keep latency bounded even when upstream VAD goes quiet. */
const MAX_CHUNK_FRAMES = 30 * SAMPLE_RATE; // ~30s of audio
/** Below this many frames the chunk is dropped instead of submitted —
 *  Whisper rejects sub-100ms clips and we don't want to spam errors. */
const MIN_CHUNK_FRAMES = SAMPLE_RATE / 5; // 0.2s

export interface WhisperSttOptions {
  apiKey: string;
  /** Whisper model id. Currently only "whisper-1" is generally
   *  available; gpt-4o-mini-transcribe is in preview. */
  model?: string;
  /** ISO-639-1 language code hint, e.g. "uk". Improves accuracy
   *  vs. auto-detection. */
  language?: string;
}

export class WhisperStt extends stt.STT {
  label = 'openai.WhisperSTT';
  private readonly opts: Required<Omit<WhisperSttOptions, 'apiKey'>> &
    Pick<WhisperSttOptions, 'apiKey'>;

  constructor(opts: WhisperSttOptions) {
    super({ streaming: false, interimResults: false });
    if (!opts.apiKey) {
      throw new Error(
        'WhisperStt: apiKey is required (set OPENAI_API_KEY or pass apiKey).',
      );
    }
    this.opts = {
      apiKey: opts.apiKey,
      model: opts.model ?? DEFAULT_MODEL,
      language: opts.language ?? 'uk',
    };
  }

  /** Single-shot recognize — used by callers that already have a
   *  buffered audio segment. AudioBuffer = AudioFrame[] | AudioFrame;
   *  normalize via mergeFrames so the WAV encoder always sees a flat
   *  array. */
  protected async _recognize(
    buffer: AudioBuffer,
    _abortSignal?: AbortSignal,
  ): Promise<stt.SpeechEvent> {
    const merged = Array.isArray(buffer) ? mergeFrames(buffer) : buffer;
    const wavBuffer = framesToWav([merged]);
    const text = await callWhisper(this.opts, wavBuffer);
    return {
      type: stt.SpeechEventType.FINAL_TRANSCRIPT,
      alternatives: [
        {
          text,
          language: this.opts.language,
          confidence: 1.0,
          startTime: 0,
          endTime: 0,
        },
      ],
    };
  }

  stream(options?: { connOptions?: APIConnectOptions }): stt.SpeechStream {
    return new WhisperSpeechStream(this, this.opts, options?.connOptions);
  }
}

class WhisperSpeechStream extends stt.SpeechStream {
  label = 'openai.WhisperSpeechStream';
  private readonly opts: WhisperStt['opts'];
  /** Accumulator for audio frames since the last flush. */
  private buffer: AudioFrame[] = [];
  private bufferFrameCount = 0;

  constructor(
    parent: WhisperStt,
    opts: WhisperStt['opts'],
    connOptions?: APIConnectOptions,
  ) {
    super(parent, SAMPLE_RATE, connOptions);
    this.opts = opts;
  }

  protected override async run(): Promise<void> {
    try {
      // Pull frames from `this.input` (filled by the agent pipeline
      // via pushFrame()). FLUSH_SENTINEL → submit accumulated buffer.
      // End-of-input → submit final buffer + exit.
      for await (const item of this.input) {
        if (item === stt.SpeechStream.FLUSH_SENTINEL) {
          await this.submitAccumulated();
          continue;
        }
        const frame = item as AudioFrame;
        this.buffer.push(frame);
        // `samplesPerChannel` reflects the frame's sample count
        // regardless of sample rate; our SAMPLE_RATE constant pins
        // the resampler upstream to 16k.
        this.bufferFrameCount += frame.samplesPerChannel;
        if (this.bufferFrameCount >= MAX_CHUNK_FRAMES) {
          await this.submitAccumulated();
        }
      }
      // Input ended (call teardown) — flush whatever's left.
      await this.submitAccumulated();
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      throw err;
    } finally {
      this.queue.close();
    }
  }

  private async submitAccumulated(): Promise<void> {
    if (this.bufferFrameCount < MIN_CHUNK_FRAMES) {
      // Too small to bother — drop and continue accumulating.
      this.buffer = [];
      this.bufferFrameCount = 0;
      return;
    }
    const frames = this.buffer;
    this.buffer = [];
    this.bufferFrameCount = 0;
    try {
      const wavBuffer = framesToWav(frames);
      const text = await callWhisper(this.opts, wavBuffer);
      if (!text.trim()) return; // empty transcript — skip emit
      this.queue.put({
        type: stt.SpeechEventType.FINAL_TRANSCRIPT,
        alternatives: [
          {
            text,
            language: this.opts.language,
            confidence: 1.0,
            startTime: 0,
            endTime: 0,
          },
        ],
      });
    } catch (err) {
      // Per-chunk failure must NOT crash the stream — log and keep
      // pulling. The agent-call.handler's STT-stall watchdog will
      // catch sustained silence at the application layer.
      livekitLog().warn(
        { err: (err as Error).message },
        'WhisperStt chunk submission failed',
      );
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────

/**
 * Concatenate PCM frames into a single WAV-encoded Buffer suitable
 * for multipart/form-data upload. Whisper accepts WAV, MP3, OGG,
 * M4A, etc.; WAV is the simplest to produce in-memory without an
 * encoder dependency.
 *
 * Format: 16-bit signed PCM, little-endian, mono, SAMPLE_RATE Hz.
 */
function framesToWav(frames: AudioFrame[]): Buffer {
  // Sum sample counts to size the data chunk precisely.
  const totalSamples = frames.reduce(
    (acc, f) => acc + f.samplesPerChannel,
    0,
  );
  const dataBytes = totalSamples * 2; // 16-bit
  const wav = Buffer.alloc(44 + dataBytes);
  // RIFF header
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write('WAVE', 8);
  // fmt chunk
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16); // chunk size
  wav.writeUInt16LE(1, 20); // PCM
  wav.writeUInt16LE(NUM_CHANNELS, 22);
  wav.writeUInt32LE(SAMPLE_RATE, 24);
  wav.writeUInt32LE(SAMPLE_RATE * NUM_CHANNELS * 2, 28); // byte rate
  wav.writeUInt16LE(NUM_CHANNELS * 2, 32); // block align
  wav.writeUInt16LE(16, 34); // bits per sample
  // data chunk
  wav.write('data', 36);
  wav.writeUInt32LE(dataBytes, 40);
  // Sample payload — each AudioFrame's `data` is a Int16Array view
  // over the underlying buffer. Copy into the WAV buffer at the
  // current offset.
  let offset = 44;
  for (const frame of frames) {
    const view = frame.data as Int16Array;
    const byteLength = view.byteLength;
    Buffer.from(view.buffer, view.byteOffset, byteLength).copy(wav, offset);
    offset += byteLength;
  }
  return wav;
}

/**
 * POST the WAV buffer to OpenAI's Whisper endpoint, return the
 * transcribed text. multipart/form-data hand-rolled to avoid a
 * `form-data` package dependency.
 */
async function callWhisper(
  opts: { apiKey: string; model: string; language: string },
  wavBuffer: Buffer,
): Promise<string> {
  const boundary = `mova-whisper-${Math.random().toString(36).slice(2)}`;
  const parts: Buffer[] = [];
  const text = (s: string): Buffer => Buffer.from(s, 'utf8');
  // file part
  parts.push(text(`--${boundary}\r\n`));
  parts.push(
    text(
      'Content-Disposition: form-data; name="file"; filename="audio.wav"\r\n' +
        'Content-Type: audio/wav\r\n\r\n',
    ),
  );
  parts.push(wavBuffer);
  parts.push(text('\r\n'));
  // model + language fields
  for (const [k, v] of Object.entries({
    model: opts.model,
    language: opts.language,
    response_format: 'json',
  })) {
    parts.push(text(`--${boundary}\r\n`));
    parts.push(
      text(`Content-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`),
    );
  }
  parts.push(text(`--${boundary}--\r\n`));
  const body = Buffer.concat(parts);

  const res = await fetch(WHISPER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': String(body.length),
    },
    body,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Whisper HTTP ${res.status}: ${detail.slice(0, 200)}`);
  }
  const payload = (await res.json()) as { text?: string };
  return payload.text ?? '';
}

// Suppress unused-import warning for Logger if the module ever
// chooses to use NestJS logger instead of LiveKit's.
const _unusedLogger = Logger;
void _unusedLogger;

// AudioByteStream is imported as a future-use hook for resampling
// pipelines without depending on the import-graph stability of
// LiveKit's audio utilities. Currently unused but kept so a follow-up
// can wire pre-Whisper resampling without modifying imports.
const _unusedAudioByteStream = AudioByteStream;
void _unusedAudioByteStream;
