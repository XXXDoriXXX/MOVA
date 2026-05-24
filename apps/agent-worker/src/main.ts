/**
 * agent-worker entry point.
 *
 * Hybrid service: exposes minimal HTTP for K8s health probes, but the real work
 * happens via Redis pub/sub (call-dispatch / call-controls) and LiveKit Agents
 * runtime (started inside AgentRunnerService).
 */
import './instrument';

import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';

import type { AppEnv } from '@mova-back/shared-config';

import { AppModule } from './app/app.module';

/**
 * Process-wide guards against the worst-case failure mode of the LiveKit
 * Agents pipeline: a plugin (TTS/STT/LLM) emits 'error' on an internal
 * EventEmitter that nobody listens to. Node's default reaction is to
 * mark it as an unhandled error and exit non-zero — which kills the
 * worker mid-call, drops every concurrent session, and shows the user
 * a generic AGENT_LOST modal.
 *
 * Real example we hit: GoogleCloudTts → StreamAdapter wraps it →
 * StreamAdapter forwards inner 'error' to its own 'error' event.
 * AgentSession is supposed to listen but doesn't in some versions; net
 * result was an unhandledRejection trace.
 *
 * We log and SWALLOW these instead so the per-call handler's safeSay /
 * watchdog / fallback chain can deal with the failure as a recoverable
 * event. The process stays alive to serve other concurrent calls.
 */
function installProcessGuards(): void {
  const log = (label: string, payload: unknown): void => {
    const err = payload instanceof Error ? payload : new Error(String(payload));
    process.stderr.write(
      `[agent-worker] ${label}: ${err.message}\n${err.stack ?? ''}\n`,
    );
  };
  process.on('unhandledRejection', (reason) => {
    log('unhandledRejection', reason);
  });
  process.on('uncaughtException', (err) => {
    log('uncaughtException', err);
    // We deliberately do NOT process.exit(). An uncaught exception
    // inside an EventEmitter plugin should not nuke active calls — the
    // call's own state machine + safeSay timeout + watchdogs handle
    // TTS/STT failures cleanly. If this masks a fatal data-corruption
    // bug later we'll need a per-error allowlist; for now, surviving
    // serves the deaf-user contract (a call always has a clean end)
    // better than crashing.
  });
}

async function bootstrap(): Promise<void> {
  installProcessGuards();
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();

  const config = app.get<ConfigService<AppEnv, true>>(ConfigService);

  // agent-worker exposes only /health, /metrics. Helmet defaults
  // (default CSP + same-origin) are fine. HSTS for parity with
  // sibling services.
  app.use(
    helmet({
      hsts: { maxAge: 15_552_000, includeSubDomains: true, preload: false },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    }),
  );

  const port = config.get('PORT', { infer: true });
  await app.listen(port);

  const logger = app.get(Logger);
  logger.log(`🚀 agent-worker listening on http://localhost:${port}`);
}

bootstrap().catch((err) => {
  process.stderr.write(`[agent-worker] Fatal bootstrap error: ${String(err)}\n`);
  process.exit(1);
});
