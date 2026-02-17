import { defineAgent, JobContext } from '@livekit/agents';
import * as silero from '@livekit/agents-plugin-silero';
import { Redis } from 'ioredis';
import * as dotenv from 'dotenv';
import { join } from 'path';

// Завантажуємо .env з кореня проекту (підніміться на потрібну кількість рівнів)
dotenv.config({ path: join(__dirname, '../../../.env') });
// Припускаємо, що ці класи можна імпортувати як чисті функції/класи
import { AgentFactory, AgentContext } from './app/agent.factory';

/**
 * Global Redis instance for the worker process.
 * Since the worker is a separate process, it needs its own connection.
 */
let redisClient: Redis | null = null;

const getRedis = () => {
  if (!redisClient) {
    // Отримуємо пароль та URL з оточення
    const host = process.env.REDIS_HOST || '127.0.0.1';
    const port = parseInt(process.env.REDIS_PORT || '6379', 10);
    const password = process.env.REDIS_PASSWORD; // Ваш пароль тут

    console.log(`📡 [WORKER] Connecting to Redis at ${host}:${port}...`);

    redisClient = new Redis({
      host,
      port,
      password, // Додаємо поле password для авторизації
      maxRetriesPerRequest: null,
    });

    redisClient.on('error', (err) => {
      if (err.message.includes('NOAUTH')) {
        console.error('❌ Redis Auth Failed: Password is required or incorrect.');
      } else {
        console.error('❌ Redis Error:', err);
      }
    });
  }
  return redisClient;
};

export default defineAgent({
  prewarm: async (proc) => {
    proc.userData.vad = await silero.VAD.load();
  },

  entry: async (ctx: JobContext) => {
    await ctx.connect();
    const roomName = ctx.room.name;
    const redis = getRedis();
    const agentFactory = new AgentFactory(); // Створюємо екземпляр вручну для воркера

    console.log(`🔗 [WORKER] Connected to room: ${roomName}`);

    const redisKey = `call:${roomName}:context`;
    const contextRaw = await redis.get(redisKey);

    if (!contextRaw) {
      console.error(`❌ Context not found for room ${roomName}.`);
      await ctx.room.disconnect();
      return;
    }

    const userContext: AgentContext = JSON.parse(contextRaw);

    const vad = (ctx.proc.userData.vad as silero.VAD) ?? (await silero.VAD.load());
    const session = await agentFactory.createSession(vad);
    const agent = agentFactory.createAgent(userContext);

    // Event streaming logic
    const sessionEmitter = session as any;

    sessionEmitter.on('user_speech_committed', (msg: { content: string }) => {
      const event = JSON.stringify({ roomName, sender: 'user', text: msg.content, timestamp: new Date() });
      void redis.publish('call-events', event);
    });

    sessionEmitter.on('agent_speech_committed', (msg: { content: string }) => {
      const event = JSON.stringify({ roomName, sender: 'agent', text: msg.content, timestamp: new Date() });
      void redis.publish('call-events', event);
    });

    session.start({ room: ctx.room, agent });

    await session.say(agentFactory.getInitialGreeting(userContext), {
      allowInterruptions: false,
    });
  },
});
