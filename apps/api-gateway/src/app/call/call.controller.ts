import { Controller, Post, Body, HttpCode, HttpStatus, UseGuards, Request } from '@nestjs/common';
import { CallService } from './call.service';
import { StartCallDto } from './dto/start-call.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('calls')
export class CallController {
  constructor(private readonly callService: CallService) {}

  @Post('start')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  async startCall(@Body() dto: StartCallDto, @Request() req: any) {
    // Pass user details to the call service context if needed
    // const user = req.user;
    return this.callService.initiateCall(dto);
  }
}
