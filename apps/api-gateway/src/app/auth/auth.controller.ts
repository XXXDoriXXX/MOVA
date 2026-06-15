import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Ip,
  Patch,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';

import { CurrentUser, Public, type AuthenticatedUser } from '@mova-back/shared-auth';

import { UsersService } from '../users/users.service';
import { AuthService, type PublicUser } from './auth.service';
import {
  ChangePasswordDto,
  DeleteAccountDto,
  GoogleSignInDto,
  LoginDto,
  LogoutDto,
  RefreshDto,
  RegisterDto,
  ResendVerificationDto,
  UpdateProfileDto,
} from './dto/auth.schemas';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly usersService: UsersService,
  ) {}

  @Public()
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ auth: { limit: 5, ttl: 15 * 60 * 1000 } })
  @ApiOperation({ summary: 'Register; emails a verification link (no session)' })
  register(@Body() dto: RegisterDto): Promise<unknown> {
    return this.authService.register(dto);
  }

  @Public()
  @Post('email/resend')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ auth: { limit: 5, ttl: 15 * 60 * 1000 } })
  @ApiOperation({ summary: 'Resend the email verification link' })
  async resendVerification(@Body() dto: ResendVerificationDto): Promise<void> {
    await this.authService.resendVerification(dto.email);
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ auth: { limit: 5, ttl: 15 * 60 * 1000 } })
  @ApiOperation({ summary: 'Authenticate with email + password' })
  login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Ip() ip: string,
  ): Promise<unknown> {
    return this.authService.login(dto, {
      userAgent: this.extractUserAgent(req),
      ipAddress: ip,
    });
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Throttle({ auth: { limit: 30, ttl: 15 * 60 * 1000 } })
  @ApiOperation({ summary: 'Rotate refresh token + issue new access token' })
  refresh(
    @Body() dto: RefreshDto,
    @Req() req: Request,
    @Ip() ip: string,
  ): Promise<unknown> {
    return this.authService.refresh(dto.refreshToken, {
      userAgent: this.extractUserAgent(req),
      ipAddress: ip,
    });
  }

  @Public()
  @Post('google')
  @HttpCode(HttpStatus.OK)
  @Throttle({ auth: { limit: 30, ttl: 15 * 60 * 1000 } })
  @ApiOperation({ summary: 'Sign in or sign up via a Google ID token' })
  google(
    @Body() dto: GoogleSignInDto,
    @Req() req: Request,
    @Ip() ip: string,
  ): Promise<unknown> {
    return this.authService.googleSignIn(dto.idToken, {
      userAgent: this.extractUserAgent(req),
      ipAddress: ip,
    });
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke the presented refresh token (current device)' })
  async logout(@Body() dto: LogoutDto): Promise<void> {
    await this.authService.logout(dto.refreshToken);
  }

  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current authenticated user profile' })
  async me(@CurrentUser() user: AuthenticatedUser): Promise<PublicUser> {
    const fullUser = await this.usersService.findActiveById(user.id);
    if (!fullUser) {
      throw new UnauthorizedException();
    }
    return this.authService.toPublic(fullUser);
  }

  @Patch('me')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update profile fields (name, preferences)' })
  async updateMe(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateProfileDto,
  ): Promise<PublicUser> {
    const updated = await this.usersService.updateProfile(user.id, dto);
    return this.authService.toPublic(updated);
  }

  @Post('email/send-verification')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ auth: { limit: 5, ttl: 15 * 60 * 1000 } })
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Email a verification link to the current user' })
  async sendEmailVerification(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    const fullUser = await this.usersService.findActiveById(user.id);
    if (!fullUser) throw new UnauthorizedException();
    await this.authService.sendEmailVerification(fullUser.id, fullUser.email);
  }

  @Public()
  @Get('email/confirm')
  @Header('content-type', 'text/html; charset=utf-8')
  @ApiOperation({ summary: 'Confirm an email via the link token' })
  async confirmEmail(@Query('token') token: string): Promise<string> {
    try {
      await this.authService.confirmEmail(token ?? '');
    } catch {
      return "<html><body style='font-family:sans-serif;text-align:center;padding:48px'><h2>Посилання недійсне або застаріле</h2><p>Запросіть новий лист у застосунку.</p></body></html>";
    }
    return "<html><body style='font-family:sans-serif;text-align:center;padding:48px'><h2>Пошту підтверджено ✅</h2><p>Можете повернутися до застосунку Mova.</p></body></html>";
  }

  @Post('change-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Change password — invalidates other sessions' })
  async changePassword(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ChangePasswordDto,
  ): Promise<void> {
    await this.authService.changePassword(user.id, dto);
  }

  @Delete('me')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Soft-delete the account (anonymized after 30 days)' })
  async deleteMe(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: DeleteAccountDto,
  ): Promise<void> {
    await this.authService.deleteAccount(user.id, dto.password);
  }

  private extractUserAgent(req: Request): string | null {
    const ua = req.headers['user-agent'];
    if (!ua) return null;
    return Array.isArray(ua) ? ua[0] : ua.slice(0, 500);
  }
}
