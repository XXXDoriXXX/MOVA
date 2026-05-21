import type { AdminConversation } from '../api';

/**
 * Single row in any conversation list (dashboard / calls page).
 *
 * Status drives both the leading dot (animated when active) and the
 * badge color. Duration is rendered in mono so a column of them
 * stays vertically aligned even with varying widths.
 */
export function ConversationRow({ conv }: { conv: AdminConversation }) {
  const status = conv.status;
  return (
    <div className={`row ${status}`}>
      <div className="dot" aria-hidden />
      <div className="meta">
        <div className="top">{conv.targetPhone}</div>
        <div className="bottom">
          {conv.userEmail ?? conv.userId.slice(0, 8)} ·{' '}
          {new Date(conv.startedAt).toLocaleString('uk-UA', {
            day: '2-digit',
            month: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          })}
          {conv.errorCode ? ` · ${conv.errorCode}` : ''}
        </div>
      </div>
      <span className="duration">{formatDuration(conv.durationSeconds)}</span>
      <span className="badge">{status}</span>
    </div>
  );
}

function formatDuration(seconds: number): string {
  if (!seconds || seconds < 0) return '—';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}
