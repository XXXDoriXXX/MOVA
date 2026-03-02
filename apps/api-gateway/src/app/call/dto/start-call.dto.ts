import { IsString, IsNotEmpty, IsPhoneNumber, IsOptional } from 'class-validator';
import { AgentConfigDto } from '@mova-back/shared-agent';

export class StartCallDto {
  @IsString()
  @IsNotEmpty()
  @IsPhoneNumber(undefined, { message: 'Phone number must be valid (E.164 format preferred)' })
  targetPhone: string;

  @IsString()
  @IsNotEmpty()
  userName: string;

  @IsString()
  @IsNotEmpty()
  userRole: string; // for example: "glovo courier", "customer", "support_agent"

  @IsString()
  @IsNotEmpty()
  callReason: string; // for example: "customer support", "delivery issue", "general inquiry"

  @IsOptional()
  config?: AgentConfigDto;
}

