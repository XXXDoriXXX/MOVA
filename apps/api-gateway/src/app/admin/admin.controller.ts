import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { CurrentUser, Roles, RolesGuard, type AuthenticatedUser } from '@mova-back/shared-auth';
import {
  AuditAction,
  AuditTargetType,
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
import {
  AuditLogService,
  type AuditPage,
} from './audit-log.service';
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
 *   - Block / unblock + future admin mutations write a row to `audit_logs`
 *     via AuditLogService. The row carries actor snapshot (id, email, role
 *     at time of action), target, action enum, request metadata (ip / UA),
 *     and a JSONB metadata blob with action-specific context.
 *   - GET /admin/audit-log surfaces the trail with cursor pagination + filters.
 */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('admin')
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly auditLog: AuditLogService,
  ) {}

  /**
   * Pull a thin actor + request context for AuditLogService. Lives on the
   * controller (not the service) because Req is an HTTP concern and we want
   * the service callable from non-HTTP contexts later (cron / queue handlers).
   */
  private auditContext(
    user: AuthenticatedUser,
    req: Request,
  ): {
    actor: { id: string; email: string; role: UserRole };
    request: { ip: string | null; userAgent: string | null };
  } {
    const ip = this.firstForwardedIp(req) ?? req.ip ?? null;
    const uaHeader = req.headers['user-agent'];
    const userAgent = typeof uaHeader === 'string' ? uaHeader : null;
    return {
      actor: { id: user.id, email: user.email, role: user.role },
      request: { ip, userAgent },
    };
  }

  /** Extracts the client IP from X-Forwarded-For if our reverse proxy sets it. */
  private firstForwardedIp(req: Request): string | null {
    const header = req.headers['x-forwarded-for'];
    const raw = Array.isArray(header) ? header[0] : header;
    if (!raw) return null;
    const first = raw.split(',')[0]?.trim();
    return first ? first : null;
  }

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
    @CurrentUser() actor: AuthenticatedUser,
    @Req() req: Request,
  ): Promise<AdminUserSummary> {
    const ctx = this.auditContext(actor, req);
    return this.admin.blockUser(id, dto.reason, ctx.actor, ctx.request);
  }

  @Patch('users/:id/unblock')
  @ApiOperation({ summary: 'Unblock a user — does NOT issue new tokens' })
  unblockUser(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() req: Request,
  ): Promise<AdminUserSummary> {
    const ctx = this.auditContext(actor, req);
    return this.admin.unblockUser(id, ctx.actor, ctx.request);
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

  // ── Audit trail ──────────────────────────────────

  @Get('audit-log')
  @ApiOperation({
    summary:
      'List audit-log entries (newest first). Filter by actor/target/action/range.',
  })
  listAuditLog(
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('actorId') actorId?: string,
    @Query('action') action?: AuditAction,
    @Query('targetType') targetType?: AuditTargetType,
    @Query('targetId') targetId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<AuditPage> {
    return this.auditLog.list({
      cursor,
      limit: limit ? Number(limit) : undefined,
      actorId,
      action,
      targetType,
      targetId,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
    });
  }

  @Get('audit-log/users/:id')
  @ApiOperation({ summary: 'Audit-log entries targeting a specific user.' })
  listAuditLogForUser(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('limit') limit?: string,
  ): Promise<AuditPage> {
    return this.auditLog.listByTarget(
      AuditTargetType.USER,
      id,
      limit ? Number(limit) : undefined,
    );
  }
}
