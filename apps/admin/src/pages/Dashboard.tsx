import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import {
  getProvidersHealth,
  getStats,
  listConversations,
  type AdminConversation,
  type AdminStats,
  type ProviderHealthRow,
} from '../api';
import { ConversationRow } from '../components/ConversationRow';

const REFRESH_MS = 3_000;

export function DashboardPage() {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [active, setActive] = useState<AdminConversation[]>([]);
  const [providers, setProviders] = useState<ProviderHealthRow[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const [s, a, p] = await Promise.all([
          getStats(),
          listConversations({ status: 'active', limit: 20 }),
          getProvidersHealth(),
        ]);
        if (!cancelled) {
          setStats(s);
          setActive(a.items);
          setProviders(p.items);
          setErr(null);
        }
      } catch (e) {
        if (!cancelled) {
          setErr(e instanceof Error ? e.message : 'fetch failed');
        }
      }
    }
    tick();
    const id = setInterval(tick, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return (
    <>
      <h2>
        Дашборд
        <span className="refresh-hint">оновлюється кожні {REFRESH_MS / 1000}с</span>
      </h2>
      {err ? <div className="err">{err}</div> : null}
      <div className="tiles">
        <Tile label="Активні дзвінки" value={stats?.activeConversations ?? '—'} kind="accent" />
        <Tile label="Сьогодні всього" value={stats?.totalConversationsToday ?? '—'} />
        <Tile label="Сьогодні з помилкою" value={stats?.failedConversationsToday ?? '—'} />
        <Tile label="Інцидентів" value={stats?.openIncidents ?? '—'} />
        <Tile label="Користувачів" value={stats?.totalUsers ?? '—'} />
        <Tile label="Заблоковано" value={stats?.blockedUsers ?? '—'} kind={(stats?.blockedUsers ?? 0) > 0 ? 'inverse' : undefined} />
      </div>

      <div className="card">
        <h3>Стан провайдерів</h3>
        {providers.length === 0 ? (
          <div className="empty">
            Жодного інциденту ще не зафіксовано. Усі провайдери вважаються
            здоровими — буде запис тут, коли щось почне відвалюватись.
          </div>
        ) : (
          <div className="provider-grid">
            {providers.map((p) => (
              <div key={`${p.providerType}:${p.providerName}`} className="provider-row">
                <span className={`provider-dot ${p.status}`} />
                <div className="provider-meta">
                  <div className="provider-name">
                    {p.providerName}
                    <span className="provider-type"> · {p.providerType}</span>
                  </div>
                  <div className="provider-sub">
                    {p.status === 'down'
                      ? `${p.openIncidents} відкритих інцидент(ів)`
                      : p.status === 'degraded'
                      ? `відновився, лишилось спостерігати`
                      : 'у порядку'}
                    {p.lastErrorCode ? ` · ${p.lastErrorCode}` : ''}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <h3>Зараз у ефірі ({active.length})</h3>
        {active.length === 0 ? (
          <div className="empty">Тиша. Жодного активного дзвінка.</div>
        ) : (
          <div className="list">
            {active.map((c) => (
              <Link key={c.id} to={`/calls/${c.id}`} style={{ textDecoration: 'none' }}>
                <ConversationRow conv={c} />
              </Link>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function Tile({
  label,
  value,
  kind,
}: {
  label: string;
  value: number | string;
  kind?: 'accent' | 'inverse';
}) {
  return (
    <div className={kind ? `tile ${kind}` : 'tile'}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
    </div>
  );
}
