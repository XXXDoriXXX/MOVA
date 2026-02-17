import { Controller, Post, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { CallService } from './call.service';
import { StartCallDto } from './dto/start-call.dto';

@Controller('calls')
export class CallController {
  constructor(private readonly callService: CallService) {}

  @Post('start')
  @HttpCode(HttpStatus.OK)
  async startCall(@Body() dto: StartCallDto) {
    return this.callService.initiateCall(dto);
  }
}
