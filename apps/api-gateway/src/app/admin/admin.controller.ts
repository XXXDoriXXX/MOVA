import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { Roles, RolesGuard } from '@mova-back/shared-auth';
import {
  ConversationStatus,
  UserRole,
  type Conversation,
  type ProviderIncident,
} from '@mova-back/shared-database';

import {
  AdminService,
  type AdminStats,
  type AdminUserSummary,
  type CursorPage,
} from './admin.service';
import { BlockUserDto } from './dto/admin.schemas';

/**
 * Admin REST surface (Phase 10 MVP slice).
 *
 * Security model:
 *   - Global JwtAuthGuard provides authentication for all routes.
 *   - @UseGuards(RolesGuard) + @Roles(UserRole.ADMIN) enforces authorization.
 *     Non-admin users hit a 403 BEFORE the handler runs.
 *   - All routes are under /v1/admin/ — Phase 16 will add a separate
 *     subdomain (admin.mova.app) so we can restrict by IP allowlist at the
 *     load-balancer level.
 *
 * Audit:
 *   - Block / unblock log via Logger today; a proper AuditLog table lands
 *     in Phase 9 follow-up. The pino logs are JSON + structured so they
 *     survive log-aggregation queries until then.
 */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  // ── Users ─────────────────────────────────────────

  @Get('users')
  @ApiOperation({ summary: 'List users (cursor pagination + search)' })
  listUsers(
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
  ): Promise<CursorPage<AdminUserSummary>> {
    return this.admin.listUsers({
      cursor,
      limit: limit ? Number(limit) : undefined,
      search,
    });
  }

  @Get('users/:id')
  @ApiOperation({ summary: 'Get a single user (admin view)' })
  getUser(@Param('id', ParseUUIDPipe) id: string): Promise<AdminUserSummary> {
    return this.admin.getUser(id);
  }

  @Patch('users/:id/block')
  @ApiOperation({
    summary: 'Block a user — revokes all refresh tokens + future JWTs',
  })
  blockUser(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: BlockUserDto,
  ): Promise<AdminUserSummary> {
    return this.admin.blockUser(id, dto.reason);
  }

  @Patch('users/:id/unblock')
  @ApiOperation({ summary: 'Unblock a user — does NOT issue new tokens' })
  unblockUser(@Param('id', ParseUUIDPipe) id: string): Promise<AdminUserSummary> {
    return this.admin.unblockUser(id);
  }

  // ── Conversations ─────────────────────────────────

  @Get('conversations')
  @ApiOperation({ summary: 'List conversations across all users' })
  listConversations(
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: ConversationStatus,
    @Query('userId') userId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<CursorPage<Conversation>> {
    return this.admin.listConversations({
      cursor,
      limit: limit ? Number(limit) : undefined,
      status,
      userId,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
    });
  }

  // ── Stats + incidents ─────────────────────────────

  @Get('stats')
  @ApiOperation({ summary: 'High-level KPI snapshot for the dashboard' })
  getStats(): Promise<AdminStats> {
    return this.admin.getStats();
  }

  @Get('incidents')
  @ApiOperation({
    summary: 'Provider incidents (active first, then recent by occurrence)',
  })
  listIncidents(
    @Query('activeOnly') activeOnly?: string,
    @Query('limit') limit?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<{ items: ProviderIncident[] }> {
    return this.admin
      .listIncidents({
        activeOnly: activeOnly === 'true',
        limit: limit ? Number(limit) : undefined,
        from: from ? new Date(from) : undefined,
        to: to ? new Date(to) : undefined,
      })
      .then((items) => ({ items }));
  }
}
