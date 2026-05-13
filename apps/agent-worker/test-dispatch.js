const process = require('process');
const Redis = require('ioredis');

// Connect to Redis (assuming local default)
const redis = new Redis('redis://localhost:6379');

async function testCall() {
  const roomName = `test-room-${Date.now()}`;
  const contextKey = `call:${roomName}:context`;

  // 1. Definition of the dynamic context with the new DTO
  const context = {
    userName: 'Олексій',
    userRole: 'Клієнт IT-компанії',
    callReason: 'Хочу дізнатися про статус мого замовлення.',
    config: {
      tts: {
        provider: 'openai',
        voice: 'nova', // Using 'nova' instead of 'fable' to test voice switching
        speed: 1.2,    // Testing speed change
        minEndpointingDelay: 700, 
        maxEndpointingDelay: 2000
      }
    }
  };

  try {
    // 2. Save Context
    console.log(`[Test] Storing context for room ${roomName}...`);
    await redis.set(contextKey, JSON.stringify(context), 'EX', 3600); // 1 hour expiry

    // 3. Dispatch Event to agent-worker
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
