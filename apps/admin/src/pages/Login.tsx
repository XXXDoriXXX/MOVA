import { useState } from 'react';

import { setToken, whoami, type WhoAmI } from '../api';

type Props = {
  onSuccess: (user: WhoAmI) => void;
};

/**
 * Single-field login. The password is the ADMIN_PASSWORD env var on
 * the backend; we POST nothing — we just store the password as the
 * bearer token and hit /admin/whoami to confirm the guard accepts it.
 *
 * If it doesn't (wrong password / panel not configured), we surface
 * the server's message verbatim. Anything more clever (typed error
 * codes) is premature for a single-user dev tool.
 */
export function LoginPage({ onSuccess }: Props) {
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setErr(null);
    setToken(password);
    try {
      const user = await whoami();
      onSuccess(user);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Не вдалось увійти');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login">
      <form onSubmit={onSubmit}>
        <h1>MOVA Admin</h1>
        <p>Введіть пароль адміністратора, заданий у <code>.env</code>.</p>
        <input
          type="password"
          autoFocus
          placeholder="ADMIN_PASSWORD"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {err ? <div className="err">{err}</div> : null}
        <button type="submit" disabled={submitting || !password}>
          {submitting ? 'Перевіряємо…' : 'Увійти'}
        </button>
      </form>
    </div>
  );
}
