import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import {
  CurrentUser,
  Public,
  type AuthenticatedUser,
} from '@mova-back/shared-auth';
import {
  AuditAction,
  AuditTargetType,
  ConversationStatus,
  type Conversation,
  type Message,
  type ProviderIncident,
  type UserRole,
} from '@mova-back/shared-database';

import {
  AdminService,
  type AdminConversationDetail,
  type AdminStats,
  type AdminUserSummary,
  type CursorPage,
} from './admin.service';
import {
  AuditLogService,
  type AuditPage,
} from './audit-log.service';
import { AdminAccessGuard } from './admin-access.guard';
import { findKnownSetting } from './settings/known-settings';
import { ProviderProbeService } from './settings/provider-probe.service';
import { SettingsService } from './settings/settings.service';
import {
  BlockUserDto,
  ForceEndConversationDto,
  ResolveIncidentDto,
} from './dto/admin.schemas';

/**
 * Admin REST surface.
 *
 * Security model:
 *   - All routes are marked @Public() so the global JwtAuthGuard skips
 *     them (it would 401 the shared-password path otherwise). The
 *     real auth is done by AdminAccessGuard — see its file for the
 *     two accepted credentials (admin-role JWT OR ADMIN_PASSWORD
 *     bearer). The guard injects `request.user`, so downstream
 *     handlers + @CurrentUser() work unchanged.
 *   - All routes are under /v1/admin/. Production should restrict by
 *     IP allowlist or VPN at the load-balancer level.
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
@Public()
@UseGuards(AdminAccessGuard)
@Controller('admin')
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly auditLog: AuditLogService,
    private readonly settings: SettingsService,
    private readonly probe: ProviderProbeService,
  ) {}

  /**
   * Auth probe — the admin UI calls this on login to validate the
   * password before storing it. Returns the actor identity so the UI
   * can show "logged in as foo@bar" in the header (the synthetic
   * password-only user reads as "admin@local").
   *
   * `200 OK` here means the guard let the request through; the body is
   * just the snapshot. Failure paths (401 / 503) come from the guard.
   */
  @Get('whoami')
  @ApiOperation({ summary: 'Verify admin credentials and return actor snapshot' })
  whoami(@CurrentUser() user: AuthenticatedUser): {
    id: string;
    email: string;
    role: UserRole;
  } {
    return { id: user.id, email: user.email, role: user.role };
  }

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

  @Get('conversations/:id')
  @ApiOperation({
    summary:
      'Conversation detail — full row + first page of messages + incidents + owner summary',
  })
  getConversationDetail(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('messageLimit') messageLimit?: string,
  ): Promise<AdminConversationDetail> {
    return this.admin.getConversationDetail(
      id,
      messageLimit ? Number(messageLimit) : undefined,
    );
  }

  @Post('conversations/:id/force-end')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Admin force-end a call — signals LiveKit teardown + marks the conversation ENDED with reason=admin',
  })
  forceEndConversation(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ForceEndConversationDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() req: Request,
  ): Promise<Conversation> {
    const ctx = this.auditContext(actor, req);
    return this.admin.forceEndConversation(id, dto.reason, ctx.actor, ctx.request);
  }

  @Get('conversations/:id/messages')
  @ApiOperation({
    summary:
      'Paginated transcript (createdAt ASC, cursor = last seen message createdAt)',
  })
  listConversationMessages(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<CursorPage<Message>> {
    return this.admin.listConversationMessages(id, {
      cursor,
      limit: limit ? Number(limit) : undefined,
    });
  }

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

  @Get('providers/health')
  @ApiOperation({
    summary:
      'Per-provider health rollup (status derived from open incidents + recent recoveries)',
  })
  providersHealth() {
    return this.admin.providersHealth().then((items) => ({ items }));
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

  @Post('incidents/:id/resolve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Manually mark a provider incident as recovered — idempotent (no-op if already resolved)',
  })
  resolveIncident(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResolveIncidentDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() req: Request,
  ): Promise<ProviderIncident> {
    const ctx = this.auditContext(actor, req);
    return this.admin.resolveIncident(id, dto.note, ctx.actor, ctx.request);
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

  // ── Settings / API keys (admin-managed overlay) ────

  @Get('settings')
  @ApiOperation({
    summary: 'List admin-managed env keys (masked) with source provenance.',
  })
  async listSettings() {
    const items = await this.settings.listForAdmin();
    return { items };
  }

  @Put('settings/:key')
  @ApiOperation({
    summary:
      'Set/update a managed key. Persists encrypted, mutates process.env, runs the upstream probe.',
  })
  async setSetting(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('key') key: string,
    @Body() body: { value?: string },
  ) {
    const known = findKnownSetting(key);
    if (!known) throw new NotFoundException(`Unknown key: ${key}`);
    const value = (body?.value ?? '').trim();
    if (!value) {
      throw new BadRequestException('value is required (non-empty)');
    }
    const actorId = isPersistableActor(actor.id) ? actor.id : null;
    const { masked } = await this.settings.set(key, value, actorId);
    // Audit log: free-form action string isn't part of the AuditAction
    // enum yet; logging via the structured logger keeps this row in
    // Pino/Sentry until we extend the DB enum in a follow-up migration.
    // Value is NEVER logged — only the key + masked tail.
    console.log(
      `[settings] ${key} updated by ${actor.email ?? actorId ?? 'unknown'} → ${masked}`,
    );
    const probe = await this.probe.probe(known, value);
    return { masked, probe };
  }

  @Post('settings/:key/test')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Probe a candidate value against the provider WITHOUT writing it (dry-run).',
  })
  async testSetting(
    @Param('key') key: string,
    @Body() body: { value?: string },
  ) {
    const known = findKnownSetting(key);
    if (!known) throw new NotFoundException(`Unknown key: ${key}`);
    const value = (body?.value ?? '').trim();
    if (!value) {
      throw new BadRequestException('value is required (non-empty)');
    }
    return this.probe.probe(known, value);
  }

  @Delete('settings/:key')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      'Remove the DB override — value reverts to .env on next process restart.',
  })
  async clearSetting(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('key') key: string,
  ): Promise<void> {
    const known = findKnownSetting(key);
    if (!known) throw new NotFoundException(`Unknown key: ${key}`);
    await this.settings.clear(key);
    const actorId = isPersistableActor(actor.id) ? actor.id : null;
    console.log(
      `[settings] ${key} cleared by ${actor.email ?? actorId ?? 'unknown'}`,
    );
  }
}

/** AuditLogService rejects non-UUID actor ids; the synthetic admin
 *  ("admin-bypass") needs to land as null so audit rows pass FK checks. */
function isPersistableActor(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}
