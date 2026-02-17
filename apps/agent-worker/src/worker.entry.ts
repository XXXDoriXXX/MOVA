import { NestFactory } from '@nestjs/core';
import { AgentModule } from './app/agent/agent.module';
import { AgentFactory, AgentContext } from './app/agent/agent.factory';
import { defineAgent, JobContext } from '@livekit/agents';
import * as silero from '@livekit/agents-plugin-silero';
import { Logger } from '@nestjs/common';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '@mova-back/shared-redis';

let appContext: any = null;

async function getNestContext() {
  if (!appContext) {
    appContext = await NestFactory.createApplicationContext(AgentModule);
    Logger.log('🚀 [Worker] NestJS Context Initialized', 'WorkerEntry');
  }
  return appContext;
}

export default defineAgent({
  prewarm: async (proc) => {

    proc.userData.vad = await silero.VAD.load();
    await getNestContext();
  },

  entry: async (ctx: JobContext) => {
    const logger = new Logger('WorkerJob');
    const app = await getNestContext();

    const agentFactory = app.get(AgentFactory);
    const redis = app.get(REDIS_CLIENT) as Redis;
    await ctx.connect();
    const roomName = ctx.room.name;
    logger.log(`🔗 Connected to room: ${roomName}`);

    const redisKey = `call:${roomName}:context`;
    const contextRaw = await redis.get(redisKey);

    if (!contextRaw) {
      logger.error(`❌ Context not found for room ${roomName}. Disconnecting.`);
      await ctx.room.disconnect();
      return;
    }

    const userContext: AgentContext = JSON.parse(contextRaw);
    const vad = ctx.proc.userData.vad as silero.VAD;

    const session = await agentFactory.createSession(vad);
    const agent = agentFactory.createAgent(userContext);

    const sessionEmitter = session as any;
    const publishEvent = (sender: string, text: string) => {
      const event = JSON.stringify({
        roomName,
        sender,
        text,
        timestamp: new Date(),
      });

      redis.publish('call-events', event).catch(err =>
        logger.error(`Failed to publish event: ${err.message}`)
      );
    };

    sessionEmitter.on('user_speech_committed', (msg: { content: string }) => {
      publishEvent('user', msg.content);
    });

    sessionEmitter.on('agent_speech_committed', (msg: { content: string }) => {
      publishEvent('agent', msg.content);
    });

    session.start({ room: ctx.room, agent });

    await session.say(agentFactory.getInitialGreeting(userContext), {
      allowInterruptions: false,
    });
  },
});
