import { Injectable, OnApplicationBootstrap, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WorkerOptions, cli } from '@livekit/agents';
import { join } from 'path';

@Injectable()
export class AgentRunnerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AgentRunnerService.name);

  constructor(private readonly config: ConfigService) {}

  async onApplicationBootstrap() {
    if (process.env.NODE_ENV === 'test') return;

    const apiKey = this.config.getOrThrow<string>('LIVEKIT_API_KEY');
    const apiSecret = this.config.getOrThrow<string>('LIVEKIT_API_SECRET');
    const wsURL = this.config.getOrThrow<string>('LIVEKIT_URL');

    const workerPath = join(process.cwd(), 'dist/apps/agent-worker/worker.js');

    this.logger.log(`🚀 Initializing LiveKit Worker from: ${workerPath}`);

    const command = process.env.NODE_ENV === 'production' ? 'start' : 'dev';

    if (!process.argv.includes(command) && !process.argv.includes('start') && !process.argv.includes('dev')) {
      this.logger.log(`🔧 Injecting CLI command: ${command}`);
      process.argv.push(command);
    }

    try {
      await cli.runApp(
        new WorkerOptions({
          agent: workerPath,
          apiKey,
          apiSecret,
          wsURL,
          production: process.env.NODE_ENV === 'production',
        })
      );
    } catch (err: any) {
      this.logger.error(`❌ Worker Runner Failed: ${err.message}`, err.stack);
    }
  }
}
