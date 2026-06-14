import { useEffect, useState } from 'react';

import { listIncidents, type ProviderIncident } from '../api';

export function IncidentsPage() {
  const [items, setItems] = useState<ProviderIncident[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    listIncidents()
      .then((r) => setItems(r.items))
      .catch((e) => setErr(e instanceof Error ? e.message : 'fetch failed'));
  }, []);

  return (
    <>
      <h2>Інциденти</h2>
      {err ? <div className="err">{err}</div> : null}
      {items.length === 0 ? (
        <div className="empty">
          Чисто. Жодного провайдера не лагало останнім часом.
        </div>
      ) : (
        <div className="list">
          {items.map((i) => {
            const isOpen = i.recoveredAt === null;
            return (
              <div key={i.id} className="row">
                <div
                  className="dot"
                  style={{
                    background: isOpen ? 'var(--danger)' : 'var(--mute)',
                  }}
                />
                <div className="meta">
                  <div className="top">
                    {i.providerName} · {i.providerType}
                  </div>
                  <div className="bottom">
                    {i.errorCode}
                    {i.errorMessage ? ` — ${i.errorMessage}` : ''}
                  </div>
                </div>
                <span className="duration">
                  {new Date(i.occurredAt).toLocaleString('uk-UA', {
                    day: '2-digit',
                    month: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
                <span
                  className="badge"
                  style={{
                    background: isOpen
                      ? 'rgba(229,72,61,0.12)'
                      : 'var(--surface-muted)',
                    color: isOpen ? 'var(--danger)' : 'var(--ink)',
                  }}
                >
                  {isOpen ? 'open' : 'recovered'}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
