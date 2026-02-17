import { Injectable, OnApplicationBootstrap, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WorkerOptions, cli } from '@livekit/agents';
import { join } from 'node:path';

@Injectable()
export class AgentWorkerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AgentWorkerService.name);

  constructor(private readonly config: ConfigService) {}

  async onApplicationBootstrap() {
    const apiKey = this.config.get<string>('LIVEKIT_API_KEY');
    const apiSecret = this.config.get<string>('LIVEKIT_API_SECRET');
    const wsURL = this.config.get<string>('LIVEKIT_URL');

    // Налаштування аргументів для LiveKit CLI
    if (!process.argv.includes('dev') && !process.argv.includes('start')) {
      process.argv.push('dev');
    }

    /**
     * In Nx, files are compiled to the dist/ folder.
     * We point to the sibling file 'agent.logic.js' in the same directory.
     */
    const agentPath = join(__dirname, 'agent.logic.js');

    try {
      this.logger.log('🚀 Launching LiveKit Runner...');

      // cli.runApp is a blocking call that manages the worker pool
      await cli.runApp(
        new WorkerOptions({
          agent: agentPath, // Points to the file with 'export default defineAgent'
          apiKey,
          apiSecret,
          wsURL,
        }),
      );
    } catch (err: any) {
      this.logger.error(`❌ Runner initialization failed: ${err?.message}`);
    }
  }
}
