const process = require('process');
const Redis = require('ioredis');

const redis = new Redis('redis://localhost:6379');

async function testCall() {
  const roomName = `test-room-${Date.now()}`;
  const contextKey = `call:${roomName}:context`;

  const context = {
    userName: 'Олексій',
    userRole: 'Клієнт IT-компанії',
    callReason: 'Хочу дізнатися про статус мого замовлення.',
    config: {
      tts: {
        provider: 'openai',
        voice: 'nova',
        speed: 1.2,
        minEndpointingDelay: 700, 
        maxEndpointingDelay: 2000
      }
    }
  };

  try {
    console.log(`[Test] Storing context for room ${roomName}...`);
    await redis.set(contextKey, JSON.stringify(context), 'EX', 3600);

    const dispatchPayload = { roomName };
    console.log(`[Test] Dispatching call event to 'call-dispatch' channel...`);
    await redis.publish('call-dispatch', JSON.stringify(dispatchPayload));

    console.log(`[Test] ✅ Dispatched successfully! Check the agent-worker logs for room ${roomName}.`);
  } catch (err) {
    console.error(`[Test] ❌ Error:`, err);
  } finally {
    redis.quit();
    process.exit(0);
  }
}

testCall();
