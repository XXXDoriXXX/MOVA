import { useEffect, useMemo, useState } from 'react';

import {
  clearSetting,
  listSettings,
  setSetting,
  testSetting,
  type SettingProbeResult,
  type SettingRow,
} from '../api';

export function SettingsPage() {
  const [items, setItems] = useState<SettingRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    try {
      const r = await listSettings();
      setItems(r.items);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'fetch failed');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  const byGroup = useMemo(() => {
    const g: Record<string, SettingRow[]> = {};
    for (const it of items) {
      g[it.group] = g[it.group] ?? [];
      g[it.group].push(it);
    }
    return g;
  }, [items]);

  return (
    <>
      <h2>
        Ключі та налаштування
        <span className="refresh-hint">
          збережене значення зашифровано · plaintext по API не повертається
        </span>
      </h2>
      {err ? <div className="err">{err}</div> : null}
      {loading ? (
        <div className="empty">Завантажую…</div>
      ) : (
        Object.entries(byGroup).map(([group, rows]) => (
          <div key={group} className="card">
            <h3>{group}</h3>
            <div className="list">
              {rows.map((r) => (
                <SettingRowEditor
                  key={r.key}
                  row={r}
                  onSaved={refresh}
                />
              ))}
            </div>
          </div>
        ))
      )}
    </>
  );
}

function SettingRowEditor({
  row,
  onSaved,
}: {
  row: SettingRow;
  onSaved: () => void;
}) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState<null | 'save' | 'test' | 'clear'>(null);
  const [result, setResult] = useState<SettingProbeResult | null>(null);

  async function onSave() {
    if (!value.trim()) return;
    setBusy('save');
    setResult(null);
    try {
      const r = await setSetting(row.key, value.trim());
      setResult(r.probe);
      setValue('');
      onSaved();
    } catch (e) {
      setResult({
        ok: false,
        message: e instanceof Error ? e.message : 'збереження впало',
      });
    } finally {
      setBusy(null);
    }
  }

  async function onTest() {
    if (!value.trim()) return;
    setBusy('test');
    setResult(null);
    try {
      const r = await testSetting(row.key, value.trim());
      setResult(r);
    } catch (e) {
      setResult({
        ok: false,
        message: e instanceof Error ? e.message : 'тест впав',
      });
    } finally {
      setBusy(null);
    }
  }

  async function onClear() {
    if (!confirm(`Прибрати override для ${row.key}? .env-значення підтягнеться при наступному рестарті.`)) return;
    setBusy('clear');
    try {
      await clearSetting(row.key);
      setResult(null);
      onSaved();
    } catch (e) {
      setResult({
        ok: false,
        message: e instanceof Error ? e.message : 'очистка впала',
      });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="setting-row">
      <div className="setting-head">
        <div className="setting-label">
          {row.label}
          <code>{row.key}</code>
        </div>
        <div className="setting-current">
          {row.masked ? (
            <>
              <span className="mask">{row.masked}</span>
              <span className={`source-badge ${row.source}`}>
                {row.source === 'db' ? 'managed' : '.env'}
              </span>
            </>
          ) : (
            <span className="source-badge unset">unset</span>
          )}
        </div>
      </div>
      <div className="setting-desc">{row.description}</div>
      <div className="setting-controls">
        <input
          type="password"
          placeholder="Нове значення"
          autoComplete="new-password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button onClick={onTest} disabled={!value.trim() || busy !== null}>
          {busy === 'test' ? 'Перевіряю…' : 'Перевірити'}
        </button>
        <button
          onClick={onSave}
          disabled={!value.trim() || busy !== null}
          className="primary"
        >
          {busy === 'save' ? 'Зберігаю…' : 'Зберегти'}
        </button>
        {row.source === 'db' ? (
          <button onClick={onClear} disabled={busy !== null} className="ghost">
            {busy === 'clear' ? 'Очищую…' : 'Скинути'}
          </button>
        ) : null}
      </div>
      {result ? (
        <div className={`probe-result ${result.ok ? 'ok' : 'fail'}`}>
          {result.ok ? '✓' : '✗'} {result.message}
        </div>
      ) : null}
    </div>
  );
}
