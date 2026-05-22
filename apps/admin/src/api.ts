/**
 * Tiny fetch wrapper for the admin panel. Treats the bearer token as
 * either the shared ADMIN_PASSWORD or an admin-role JWT — backend's
 * AdminAccessGuard accepts both.
 *
 * No retry / backoff: admin is a low-traffic dev tool, and a failed
 * call surfaces fast through React's error boundary so the operator
 * can react.
 */

const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? '/v1';

const TOKEN_KEY = 'mova.admin.token';

export function getToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY);
}
export function setToken(t: string): void {
  sessionStorage.setItem(TOKEN_KEY, t);
}
export function clearToken(): void {
  sessionStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (res.status === 401 || res.status === 403) {
    clearToken();
    throw new ApiError(res.status, 'unauthorized');
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ApiError(res.status, text || res.statusText);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// ── Endpoints ──────────────────────────────────────────────────────

export interface WhoAmI {
  id: string;
  email: string;
  role: 'admin' | 'user';
}

export function whoami(): Promise<WhoAmI> {
  return request<WhoAmI>('/admin/whoami');
}

export interface AdminStats {
  totalUsers: number;
  blockedUsers: number;
  activeConversations: number;
  totalConversationsToday: number;
  failedConversationsToday: number;
  openIncidents: number;
}

export function getStats(): Promise<AdminStats> {
  return request<AdminStats>('/admin/stats');
}

export interface AdminConversation {
  id: string;
  userId: string;
  userEmail: string | null;
  targetPhone: string;
  status: 'pending' | 'active' | 'ended' | 'failed';
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number;
  endReason: string | null;
  errorCode: string | null;
}

export interface ConversationsPage {
  items: AdminConversation[];
  nextCursor: string | null;
}

export function listConversations(params: {
  status?: AdminConversation['status'];
  cursor?: string;
  limit?: number;
}): Promise<ConversationsPage> {
  const q = new URLSearchParams();
  if (params.status) q.set('status', params.status);
  if (params.cursor) q.set('cursor', params.cursor);
  q.set('limit', String(params.limit ?? 30));
  return request<ConversationsPage>(`/admin/conversations?${q}`);
}

export interface AdminMessage {
  id: string;
  role: 'interlocutor' | 'ai' | 'user_typed' | 'system';
  content: string;
  createdAt: string;
  ttsStatus?: string | null;
}

export interface AdminConversationDetail extends AdminConversation {
  livekitRoom: string | null;
  initialLlmProvider: string | null;
  initialTtsProvider: string | null;
  initialVoice: string | null;
  templateId: string | null;
}

export function getConversation(id: string): Promise<AdminConversationDetail> {
  return request<AdminConversationDetail>(`/admin/conversations/${id}`);
}

export function getConversationMessages(id: string): Promise<{ items: AdminMessage[] }> {
  return request<{ items: AdminMessage[] }>(
    `/admin/conversations/${id}/messages?limit=200`,
  );
}

export function forceEndConversation(id: string, reason: string): Promise<void> {
  return request(`/admin/conversations/${id}/force-end`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'user';
  language: string;
  isBlocked: boolean;
  createdAt: string;
}

export interface UsersPage {
  items: AdminUser[];
  nextCursor: string | null;
}

export function listUsers(params: {
  cursor?: string;
  limit?: number;
  search?: string;
}): Promise<UsersPage> {
  const q = new URLSearchParams();
  if (params.cursor) q.set('cursor', params.cursor);
  if (params.search) q.set('search', params.search);
  q.set('limit', String(params.limit ?? 30));
  return request<UsersPage>(`/admin/users?${q}`);
}

export function blockUser(id: string, reason: string): Promise<void> {
  return request(`/admin/users/${id}/block`, {
    method: 'PATCH',
    body: JSON.stringify({ reason }),
  });
}

export function unblockUser(id: string): Promise<void> {
  return request(`/admin/users/${id}/unblock`, { method: 'PATCH' });
}

export interface ProviderIncident {
  id: string;
  /** "stt" | "llm" | "tts" — matches the backend enum. */
  providerType: string;
  providerName: string;
  errorCode: string;
  errorMessage: string;
  conversationId: string | null;
  occurredAt: string;
  recoveredAt: string | null;
}

export function listIncidents(): Promise<{ items: ProviderIncident[] }> {
  return request<{ items: ProviderIncident[] }>(`/admin/incidents`);
}

export interface ProviderHealthRow {
  providerType: string;
  providerName: string;
  status: 'healthy' | 'degraded' | 'down';
  openIncidents: number;
  lastErrorCode: string | null;
  lastOccurredAt: string;
  lastRecoveredAt: string | null;
}

export function getProvidersHealth(): Promise<{ items: ProviderHealthRow[] }> {
  return request<{ items: ProviderHealthRow[] }>(`/admin/providers/health`);
}
