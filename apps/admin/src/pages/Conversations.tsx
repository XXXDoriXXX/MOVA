import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import {
  listConversations,
  type AdminConversation,
} from '../api';
import { ConversationRow } from '../components/ConversationRow';

const REFRESH_MS = 5_000;
type Filter = 'all' | 'active' | 'ended' | 'failed';

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'Усі' },
  { id: 'active', label: 'Активні' },
  { id: 'ended', label: 'Завершені' },
  { id: 'failed', label: 'З помилкою' },
];

export function ConversationsPage() {
  const [filter, setFilter] = useState<Filter>('all');
  const [items, setItems] = useState<AdminConversation[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function tick(opts?: { reset?: boolean }) {
      try {
        const res = await listConversations({
          status: filter === 'all' ? undefined : filter,
          limit: 30,
        });
        if (!cancelled) {
          setItems(res.items);
          setCursor(res.nextCursor);
          setErr(null);
          if (opts?.reset) setLoadingMore(false);
        }
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : 'fetch failed');
      }
    }
    tick({ reset: true });
    const id = setInterval(tick, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [filter]);

  async function loadMore() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await listConversations({
        status: filter === 'all' ? undefined : filter,
        cursor,
        limit: 30,
      });
      setItems((prev) => [...prev, ...res.items]);
      setCursor(res.nextCursor);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'fetch failed');
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <>
      <h2>
        Дзвінки
        <span className="refresh-hint">live · кожні {REFRESH_MS / 1000}с</span>
      </h2>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        {FILTERS.map((f) => (
          <button
            key={f.id}
            onClick={() => setFilter(f.id)}
            style={{
              padding: '8px 14px',
              borderRadius: 999,
              border: '1px solid var(--border)',
              background: filter === f.id ? 'var(--ink)' : 'var(--surface)',
              color: filter === f.id ? 'var(--bg)' : 'var(--ink)',
              fontWeight: 600,
              fontSize: 13,
            }}
          >
            {f.label}
          </button>
        ))}
      </div>

      {err ? <div className="err">{err}</div> : null}

      {items.length === 0 ? (
        <div className="empty">Нічого не знайдено за цим фільтром.</div>
      ) : (
        <div className="list">
          {items.map((c) => (
            <Link key={c.id} to={`/calls/${c.id}`} style={{ textDecoration: 'none' }}>
              <ConversationRow conv={c} />
            </Link>
          ))}
        </div>
      )}

      {cursor ? (
        <button
          onClick={loadMore}
          disabled={loadingMore}
          style={{
            marginTop: 16,
            padding: '10px 18px',
            borderRadius: 999,
            border: '1px solid var(--border)',
            background: 'var(--surface)',
            fontWeight: 600,
          }}
        >
          {loadingMore ? 'Завантаження…' : 'Показати ще'}
        </button>
      ) : null}
    </>
  );
}
