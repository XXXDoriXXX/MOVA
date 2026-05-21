import { useEffect, useState } from 'react';

import { listIncidents, type ProviderIncident } from '../api';

/**
 * Provider incidents — STT/LLM/TTS that hit the circuit breaker.
 * Severity colour + open/resolved status. Resolving from the UI is
 * intentionally NOT exposed here (the resolve endpoint exists in
 * the API but admins can mark them via a follow-up step in v2).
 */
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
          {items.map((i) => (
            <div key={i.id} className="row">
              <div
                className="dot"
                style={{
                  background:
                    i.severity === 'critical'
                      ? 'var(--danger)'
                      : i.severity === 'high'
                        ? 'var(--warning)'
                        : 'var(--mute)',
                }}
              />
              <div className="meta">
                <div className="top">
                  {i.providerId} · {i.category}
                </div>
                <div className="bottom">{i.message}</div>
              </div>
              <span className="duration">
                {new Date(i.detectedAt).toLocaleString('uk-UA', {
                  day: '2-digit',
                  month: '2-digit',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
              <span
                className="badge"
                style={{
                  background:
                    i.status === 'open'
                      ? 'rgba(229,72,61,0.12)'
                      : 'var(--surface-muted)',
                  color: i.status === 'open' ? 'var(--danger)' : 'var(--ink)',
                }}
              >
                {i.status}
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
