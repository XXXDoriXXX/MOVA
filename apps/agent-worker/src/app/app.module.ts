import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AgentModule } from './agent/agent.module';
import { AgentRunnerService } from './agent-runner.service';

@Module({
  imports: [
    AgentModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    AgentRunnerService
  ],
})
export class AppModule {}
