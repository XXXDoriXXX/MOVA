import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import {
  forceEndConversation,
  getConversation,
  getConversationMessages,
  type AdminConversationDetail,
  type AdminMessage,
} from '../api';

const REFRESH_MS = 2_500;

/**
 * Per-call detail. Shows the full transcript, meta block, and three
 * actions:
 *   - "Force end" (only when status=active) — server marks the call
 *     failed and tears down the room
 *   - "Open in Dozzle" — convenience link to the log viewer scoped
 *     to all containers; the operator greps for the conversation id
 *     to scope further
 *   - "Back"
 *
 * Polls until the call is no longer active so a live read-along is
 * possible without manual refresh.
 */
export function ConversationDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [conv, setConv] = useState<AdminConversationDetail | null>(null);
  const [messages, setMessages] = useState<AdminMessage[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    async function tick() {
      try {
        const [c, m] = await Promise.all([
          getConversation(id!),
          getConversationMessages(id!),
        ]);
        if (cancelled) return;
        setConv(c);
        setMessages(m.items);
        setErr(null);
      } catch (e) {
        if (cancelled) return;
        setErr(e instanceof Error ? e.message : 'fetch failed');
      }
    }
    tick();
    const interval = setInterval(() => {
      // Stop polling once the call is no longer live — saves bandwidth
      // on the long-tail of viewing historic calls.
      if (conv && conv.status !== 'active' && conv.status !== 'pending') {
        return;
      }
      tick();
    }, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [id, conv?.status]);

  async function handleForceEnd() {
    if (!id || !conv) return;
    if (!confirm('Завершити цей дзвінок примусово?')) return;
    try {
      await forceEndConversation(id, 'Force-ended by admin');
      const updated = await getConversation(id);
      setConv(updated);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'force-end failed');
    }
  }

  if (!conv) {
    return (
      <>
        <Link to="/calls" className="back-link">← До списку</Link>
        <div className="spinner" style={{ marginTop: 24 }} />
        {err ? <div className="err">{err}</div> : null}
      </>
    );
  }

  const isLive = conv.status === 'active' || conv.status === 'pending';

  return (
    <>
      <Link to="/calls" className="back-link">← До списку</Link>
      <h2>
        {conv.targetPhone}
        <span className="sub">{conv.id.slice(0, 8)}</span>
      </h2>

      <div className="detail-actions">
        {isLive ? (
          <button className="danger" onClick={handleForceEnd}>
            Завершити примусово
          </button>
        ) : null}
        <a
          href={`http://localhost:9999/show?name=mova_`}
          target="_blank"
          rel="noopener noreferrer"
        >
          Відкрити логи в Dozzle ↗
        </a>
        <button onClick={() => navigate(`/users?focus=${conv.userId}`)}>
          Відкрити користувача
        </button>
      </div>

      {err ? <div className="err">{err}</div> : null}

      <div className="detail-grid">
        <div className="card">
          <h3>Транскрипт ({messages.length})</h3>
          <div className="transcript">
            {messages.length === 0 ? (
              <div className="empty">Поки що жодного повідомлення.</div>
            ) : (
              messages.map((m) => (
                <div key={m.id} className={`bubble ${m.role}`}>
                  <div className="who">{roleLabel(m.role)}</div>
                  {m.content}
                  {m.ttsStatus === 'interrupted' ? (
                    <div style={{ fontSize: 11, opacity: 0.6, marginTop: 6 }}>
                      (перервано)
                    </div>
                  ) : null}
                </div>
              ))
            )}
          </div>
        </div>

        <div className="card">
          <h3>Метадані</h3>
          <div className="kv">
            <div className="k">Статус</div>
            <div>
              <span className="tag">{conv.status}</span>
              {isLive ? (
                <span className="tag" style={{ background: 'var(--accent)' }}>live</span>
              ) : null}
            </div>
            <div className="k">Користувач</div>
            <div>{conv.userEmail ?? conv.userId}</div>
            <div className="k">Початок</div>
            <div>{new Date(conv.startedAt).toLocaleString('uk-UA')}</div>
            <div className="k">Завершення</div>
            <div>
              {conv.endedAt
                ? new Date(conv.endedAt).toLocaleString('uk-UA')
                : '—'}
            </div>
            <div className="k">Тривалість</div>
            <div>
              {conv.durationSeconds > 0
                ? formatDuration(conv.durationSeconds)
                : '—'}
            </div>
            <div className="k">Причина завершення</div>
            <div>{conv.endReason ?? '—'}</div>
            <div className="k">Помилка</div>
            <div>
              {conv.errorCode ? (
                <span className="tag" style={{ background: 'rgba(229,72,61,0.12)', color: 'var(--danger)' }}>
                  {conv.errorCode}
                </span>
              ) : (
                '—'
              )}
            </div>
            <div className="k">LiveKit room</div>
            <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>
              {conv.livekitRoom ?? '—'}
            </div>
            <div className="k">LLM</div>
            <div>{conv.initialLlmProvider ?? '—'}</div>
            <div className="k">TTS</div>
            <div>{conv.initialTtsProvider ?? '—'}</div>
            <div className="k">Голос</div>
            <div>{conv.initialVoice ?? '—'}</div>
          </div>
        </div>
      </div>
    </>
  );
}

function roleLabel(role: AdminMessage['role']): string {
  switch (role) {
    case 'interlocutor': return 'Співрозмовник';
    case 'ai': return 'AI · голос';
    case 'user_typed': return 'Користувач';
    case 'system': return 'Система';
  }
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}
