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

const WHISPER_URL = 'https://api.openai.com/v1/audio/transcriptions';
const DEFAULT_MODEL = 'whisper-1';
const SAMPLE_RATE = 16_000;
const NUM_CHANNELS = 1;
const MAX_CHUNK_FRAMES = 30 * SAMPLE_RATE;
const MIN_CHUNK_FRAMES = SAMPLE_RATE / 5;

export interface WhisperSttOptions {
  apiKey: string;
  model?: string;
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
      for await (const item of this.input) {
        if (item === stt.SpeechStream.FLUSH_SENTINEL) {
          await this.submitAccumulated();
          continue;
        }
        const frame = item as AudioFrame;
        this.buffer.push(frame);
        this.bufferFrameCount += frame.samplesPerChannel;
        if (this.bufferFrameCount >= MAX_CHUNK_FRAMES) {
          await this.submitAccumulated();
        }
      }
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
      if (!text.trim()) return;
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
      livekitLog().warn(
        { err: (err as Error).message },
        'WhisperStt chunk submission failed',
      );
    }
  }
}

function framesToWav(frames: AudioFrame[]): Buffer {
  const totalSamples = frames.reduce(
    (acc, f) => acc + f.samplesPerChannel,
    0,
  );
  const dataBytes = totalSamples * 2;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(NUM_CHANNELS, 22);
  wav.writeUInt32LE(SAMPLE_RATE, 24);
  wav.writeUInt32LE(SAMPLE_RATE * NUM_CHANNELS * 2, 28);
  wav.writeUInt16LE(NUM_CHANNELS * 2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataBytes, 40);
  let offset = 44;
  for (const frame of frames) {
    const view = frame.data as Int16Array;
    const byteLength = view.byteLength;
    Buffer.from(view.buffer, view.byteOffset, byteLength).copy(wav, offset);
    offset += byteLength;
  }
  return wav;
}

async function callWhisper(
  opts: { apiKey: string; model: string; language: string },
  wavBuffer: Buffer,
): Promise<string> {
  const boundary = `mova-whisper-${Math.random().toString(36).slice(2)}`;
  const parts: Buffer[] = [];
  const text = (s: string): Buffer => Buffer.from(s, 'utf8');
  parts.push(text(`--${boundary}\r\n`));
  parts.push(
    text(
      'Content-Disposition: form-data; name="file"; filename="audio.wav"\r\n' +
        'Content-Type: audio/wav\r\n\r\n',
    ),
  );
  parts.push(wavBuffer);
  parts.push(text('\r\n'));
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

const _unusedLogger = Logger;
void _unusedLogger;

const _unusedAudioByteStream = AudioByteStream;
void _unusedAudioByteStream;
