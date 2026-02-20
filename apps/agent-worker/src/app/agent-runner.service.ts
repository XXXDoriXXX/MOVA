// agent-runner.service.ts
import { Injectable, OnApplicationBootstrap, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WorkerOptions, cli } from '@livekit/agents';
import { join } from 'path';
import { existsSync } from 'fs';

@Injectable()
export class AgentRunnerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AgentRunnerService.name);

  constructor(private readonly config: ConfigService) {}

  async onApplicationBootstrap() {
    if (process.env.NODE_ENV === 'test') return;

    const apiKey = this.config.getOrThrow<string>('LIVEKIT_API_KEY');
    const apiSecret = this.config.getOrThrow<string>('LIVEKIT_API_SECRET');
    const wsURL = this.config.getOrThrow<string>('LIVEKIT_URL');

    // Environment-aware resolution (Враховуємо різницю між локальним Nx та Docker)
    const isProd = process.env.NODE_ENV === 'production';

    // В Docker CMD ["node", "dist/main.js"] виконується з /app
    // Локально Nx виконує з root директорії воркспейсу
    const workerPath = isProd
      ? join(process.cwd(), 'dist', 'worker.js')
      : join(process.cwd(), 'dist/apps/agent-worker', 'worker.js');

    this.logger.log(`🚀 Resolving LiveKit Worker at: ${workerPath}`);

    // Fail-Fast Pattern: запобігаємо silent failures, якщо файл збірки відсутній
    if (!existsSync(workerPath)) {
      this.logger.error(`🚨 Fatal: Worker entry not found at ${workerPath}. Halting agent runner.`);
      return;
    }

    const command = isProd ? 'start' : 'dev';

    if (!process.argv.includes(command) && !process.argv.includes('start') && !process.argv.includes('dev')) {
      process.argv.push(command);
    }

    try {
      await cli.runApp(
        new WorkerOptions({
          agent: workerPath,
          apiKey,
          apiSecret,
          wsURL,
          production: isProd,
        })
      );
    } catch (err: any) {
      this.logger.error(`❌ Worker Runner Failed: ${err.message}`, err.stack);
    }
  }
}
