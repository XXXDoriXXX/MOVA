import { useEffect, useState, type FormEvent } from 'react';

import {
  blockUser,
  ApiError,
  createBetaTester,
  listUsers,
  unblockUser,
  type AdminUser,
} from '../api';

export function UsersPage() {
  const [items, setItems] = useState<AdminUser[]>([]);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [showBetaForm, setShowBetaForm] = useState(false);
  const [creatingTester, setCreatingTester] = useState(false);
  const [betaError, setBetaError] = useState<string | null>(null);
  const [createdTester, setCreatedTester] = useState<string | null>(null);

  async function handleCreateTester(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (creatingTester) return;
    const form = event.currentTarget;
    const fields = new FormData(form);
    const email = String(fields.get('email') ?? '').trim().toLowerCase();
    const name = String(fields.get('name') ?? '').trim();
    const username = String(fields.get('username') ?? '').trim().toLowerCase();
    const password = String(fields.get('password') ?? '');
    if (!name || !/[A-Za-zА-Яа-яЇїІіЄєҐґ]/.test(password) || !/\d/.test(password)) {
      setBetaError('Вкажіть імʼя. Пароль має містити щонайменше одну літеру та цифру.');
      return;
    }
    setBetaError(null);
    setCreatingTester(true);
    try {
      const user = await createBetaTester({ email, name, username, password });
      form.reset();
      setShowBetaForm(false);
      setCreatedTester(user.email);
      setItems((prev) => [{ ...user, isBlocked: false }, ...prev]);
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 0;
      setBetaError(
        status === 404 ? 'Доступ для тестувальників вимкнено на сервері.'
          : status === 409 ? 'Ця пошта або нікнейм уже зайняті.'
            : status === 422 ? 'Цей пароль є у відомих витоках. Оберіть інший.'
              : status === 400 ? 'Перевірте пошту, імʼя, нікнейм і вимоги до пароля.'
                : status === 401 || status === 403 ? 'Увійдіть знову як адміністратор.'
                  : 'Не вдалося створити тестувальника. Спробуйте ще раз.',
      );
    } finally {
      setCreatingTester(false);
    }
  }

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
      {!showBetaForm ? (
        <button type="button" style={{ ...btn, marginBottom: 16 }} onClick={() => {
          setBetaError(null);
          setCreatedTester(null);
          setShowBetaForm(true);
        }}>
          Додати тестувальника
        </button>
      ) : (
        <form className="card" onSubmit={handleCreateTester} style={{ marginBottom: 16 }}>
          <h3>Доступ до закритої бета-версії</h3>
          <p>Тестувальник зможе увійти з цією поштою та паролем без листа підтвердження.</p>
          <fieldset disabled={creatingTester} style={{ border: 0, padding: 0, margin: 0 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))', gap: 12 }}>
              <label>Email
                <input style={field} name="email" type="email" autoComplete="off" required minLength={3} maxLength={254} />
              </label>
              <label>Імʼя
                <input style={field} name="name" autoComplete="off" required maxLength={120} />
              </label>
              <label>Нікнейм
                <input style={field} name="username" autoComplete="off" required minLength={3} maxLength={30} pattern="[a-zA-Z0-9_.]+" aria-describedby="beta-username-help" />
              </label>
              <label>Пароль
                <input style={field} name="password" type="password" autoComplete="new-password" required minLength={8} maxLength={72} aria-describedby="beta-password-help" />
              </label>
            </div>
            <p id="beta-username-help">Нікнейм: 3–30 символів, латинські літери, цифри, крапка або підкреслення.</p>
            <p id="beta-password-help">Пароль: 8–72 символи, щонайменше одна літера та цифра. Пароль не зберігається в адмін-панелі.</p>
            {betaError ? <div className="err" role="alert">{betaError}</div> : null}
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button type="submit" style={btn}>{creatingTester ? 'Створюємо…' : 'Створити доступ'}</button>
              <button type="button" style={btn} onClick={() => {
                setShowBetaForm(false);
                setBetaError(null);
              }}>Скасувати</button>
            </div>
          </fieldset>
        </form>
      )}
      {createdTester ? <p role="status">Доступ створено для {createdTester}. Тепер можна увійти в Mova.</p> : null}
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

const field: React.CSSProperties = {
  display: 'block',
  width: '100%',
  marginTop: 6,
  padding: '10px 12px',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-lg)',
  background: 'var(--surface-muted)',
};
