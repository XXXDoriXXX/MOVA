import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';

import { Public } from '@mova-back/shared-auth';
import { JwtPayloadSchema } from '@mova-back/shared-auth';
import type { AppEnv } from '@mova-back/shared-config';

import { ReportClientErrorsDto } from './dto/telemetry.schemas';
import { TelemetryService } from './telemetry.service';

@ApiTags('telemetry')
@Controller('telemetry')
export class TelemetryController {
  constructor(
    private readonly telemetry: TelemetryService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<AppEnv, true>,
  ) {}

  @Public()
  @Post('client-errors')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: 'Ingest client error/crash reports (batch)' })
  async ingest(
    @Body() dto: ReportClientErrorsDto,
    @Req() req: Request,
  ): Promise<{ stored: number }> {
    const userId = await this.resolveUserId(req);
    const stored = await this.telemetry.record(userId, dto.events);
    return { stored };
  }

  private async resolveUserId(req: Request): Promise<string | null> {
    const header = req.headers['authorization'];
    if (!header || Array.isArray(header)) return null;
    const [scheme, token] = header.split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) return null;
    try {
      const payload = await this.jwt.verifyAsync(token, {
        secret: this.config.get('JWT_SECRET', { infer: true }),
      });
      const parsed = JwtPayloadSchema.safeParse(payload);
      return parsed.success ? parsed.data.sub : null;
    } catch {
      return null;
    }
  }
}
