import { Injectable, Inject, Logger, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SipClient } from 'livekit-server-sdk';
import { Redis } from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import { StartCallDto } from './dto/start-call.dto';
import { REDIS_CLIENT } from '@mova-back/shared-redis';


@Injectable()
export class CallService {
  private readonly logger = new Logger(CallService.name);
  private sipClient: SipClient;
  private sipTrunkId: string;

  constructor(
    private config: ConfigService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis
  ) {
    //SIP init
    const apiUrl = this.config.get<string>('LIVEKIT_URL').replace('wss://', 'https://');
    const apiKey = this.config.get<string>('LIVEKIT_API_KEY');
    const apiSecret = this.config.get<string>('LIVEKIT_API_SECRET');

    this.sipTrunkId = this.config.get<string>('SIP_TRUNK_ID');
    this.sipClient = new SipClient(apiUrl, apiKey, apiSecret);
  }

  async initiateCall(dto: StartCallDto) {
    const roomName = `call-${uuidv4()}`;

    const agentContext = {
      ...dto,
      roomName,
      createdAt: new Date().toISOString(),
    };

    const redisKey = `call:${roomName}:context`;

    try {
      await this.redis.set(redisKey, JSON.stringify(agentContext), 'EX', 3600);
      this.logger.log(`💾 Context saved for room: ${roomName}`);
    } catch (error) {
      this.logger.error(`❌ Redis Error: ${error.message}`);
      throw new InternalServerErrorException('Failed to save call context');
    }
    try {
      this.logger.log(`📞 Dialing ${dto.targetPhone} via Trunk ${this.sipTrunkId}...`);

      const participant = await this.sipClient.createSipParticipant(
        this.sipTrunkId,
        dto.targetPhone,
        roomName,
        {
          participantIdentity: `phone-${dto.targetPhone}`,
          participantName: 'Співрозмовник',
        }
      );

      this.logger.log(`✅ Call initiated. Participant ID: ${participant.participantId}`);

      const eventPayload = JSON.stringify({ roomName });

      // Публікуємо подію в канал 'call-dispatch', який слухає наш In-Process Worker
      await this.redis.publish('call-dispatch', eventPayload);
      
      this.logger.log(`📢 [Pub/Sub] Dispatched call event to worker for room: ${roomName}`);
      return {
        success: true,
        roomName,
        participantId: participant.participantId
      };

    } catch (error) {
      this.logger.error(`❌ SIP Dial Error: ${error.message}`, error.stack);
      await this.redis.del(redisKey);
      throw new InternalServerErrorException(`Failed to initiate SIP call: ${error.message}`);
    }
  }
}
