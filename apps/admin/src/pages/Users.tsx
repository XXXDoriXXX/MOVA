import { useEffect, useState } from 'react';

import {
  blockUser,
  listUsers,
  unblockUser,
  type AdminUser,
} from '../api';

/**
 * Users — searchable list with block / unblock. Search is debounced
 * so typing doesn't flood the server.
 *
 * Block + unblock fire a confirm to avoid accidental hits — these
 * mutations are visible to the user (their next request returns
 * 401 + the mobile signs them out) so we want them deliberate.
 */
export function UsersPage() {
  const [items, setItems] = useState<AdminUser[]>([]);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(search), 250);
    return () => clearTimeout(id);
  }, [search]);

  useEffect(() => {
    let cancelled = false;
    listUsers({ search: debounced || undefined, limit: 50 })
      .then((res) => {
        if (!cancelled) setItems(res.items);
      })
      .catch((e) => {
        if (!cancelled) setErr(e instanceof Error ? e.message : 'fetch failed');
      });
    return () => {
      cancelled = true;
    };
  }, [debounced]);

  async function handleBlock(u: AdminUser) {
    const reason = prompt(`Заблокувати ${u.email}? Вкажіть причину:`);
    if (!reason) return;
    try {
      await blockUser(u.id, reason);
      setItems((prev) =>
        prev.map((x) => (x.id === u.id ? { ...x, isBlocked: true } : x)),
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'block failed');
    }
  }

  async function handleUnblock(u: AdminUser) {
    if (!confirm(`Розблокувати ${u.email}?`)) return;
    try {
      await unblockUser(u.id);
      setItems((prev) =>
        prev.map((x) => (x.id === u.id ? { ...x, isBlocked: false } : x)),
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'unblock failed');
    }
  }

  return (
    <>
      <h2>Користувачі</h2>
      <input
        placeholder="Пошук за email / іменем"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        style={{
          width: '100%',
          maxWidth: 320,
          background: 'var(--surface-muted)',
          border: 'none',
          borderRadius: 'var(--radius-lg)',
          padding: '12px 16px',
          fontSize: 14,
          marginBottom: 16,
        }}
      />

      {err ? <div className="err">{err}</div> : null}
      {items.length === 0 ? (
        <div className="empty">Користувачів не знайдено.</div>
      ) : (
        <div className="card">
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--mute)', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.8 }}>
                <th style={th}>Email</th>
                <th style={th}>Імʼя</th>
                <th style={th}>Роль</th>
                <th style={th}>Створено</th>
                <th style={th}>Статус</th>
                <th style={th}></th>
              </tr>
            </thead>
            <tbody>
              {items.map((u) => (
                <tr key={u.id} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={td}>{u.email}</td>
                  <td style={td}>{u.name}</td>
                  <td style={td}>
                    <span className="tag" style={{ background: u.role === 'admin' ? 'var(--accent)' : 'var(--surface-muted)' }}>
                      {u.role}
                    </span>
                  </td>
                  <td style={td}>{new Date(u.createdAt).toLocaleDateString('uk-UA')}</td>
                  <td style={td}>
                    {u.isBlocked ? (
                      <span className="tag" style={{ background: 'rgba(229,72,61,0.12)', color: 'var(--danger)' }}>
                        блок
                      </span>
                    ) : (
                      <span className="tag" style={{ color: 'var(--success)' }}>активний</span>
                    )}
                  </td>
                  <td style={td}>
                    {u.isBlocked ? (
                      <button onClick={() => handleUnblock(u)} style={btn}>
                        Розблок
                      </button>
                    ) : (
                      <button
                        onClick={() => handleBlock(u)}
                        style={{ ...btn, color: 'var(--danger)' }}
                      >
                        Блок
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

const th: React.CSSProperties = { padding: '8px 12px' };
const td: React.CSSProperties = { padding: '12px' };
const btn: React.CSSProperties = {
  padding: '6px 12px',
  borderRadius: 999,
  border: '1px solid var(--border)',
  background: 'var(--surface)',
  fontSize: 12,
  fontWeight: 600,
};
