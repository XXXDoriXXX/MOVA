import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Patch,
  Post,
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
  LoginDto,
  LogoutDto,
  RefreshDto,
  RegisterDto,
  UpdateProfileDto,
} from './dto/auth.schemas';

/**
 * Auth endpoints.
 *
 * Rate-limit policy (uses the `auth` named bucket from app.module —
 * configured as 5 requests per 15 min per IP):
 *   - register / login: `auth` bucket. Tight enough to break a serial
 *     credential-stuffing bot (no more than 20 attempts/h), permissive
 *     enough that a forgetful human can retry a few times in a
 *     reasonable session.
 *   - refresh: `auth` bucket too — a leaked refresh token would
 *     otherwise be replayable forever; capping the rotation rate caps
 *     the blast radius.
 *   - change-password, delete-account: lower bucket (5/min via @Throttle)
 *     — privileged ops, single user, no need for sustained throughput.
 *
 * Tracker note: these endpoints are pre-auth (no req.user), so
 * UserOrIpThrottlerGuard falls back to req.ip — the right scope for
 * pre-account brute-force defence.
 */
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
  @ApiOperation({ summary: 'Register a new user account' })
  register(
    @Body() dto: RegisterDto,
    @Req() req: Request,
    @Ip() ip: string,
  ): Promise<unknown> {
    return this.authService.register(dto, {
      userAgent: this.extractUserAgent(req),
      ipAddress: ip,
    });
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
      // Token valid but user was soft-deleted in the meantime — 401, not 500.
      // The mobile client treats 401 by purging tokens + showing login.
      throw new UnauthorizedException();
    }
    return this.authService.toPublic(fullUser);
  }

  @Patch('me')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update profile fields (name, phone, preferences)' })
  async updateMe(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateProfileDto,
  ): Promise<PublicUser> {
    const updated = await this.usersService.updateProfile(user.id, dto);
    return this.authService.toPublic(updated);
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

  // ─── helpers ────────────────────────────────────────

  private extractUserAgent(req: Request): string | null {
    const ua = req.headers['user-agent'];
    if (!ua) return null;
    return Array.isArray(ua) ? ua[0] : ua.slice(0, 500);
  }
}
