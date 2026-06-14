import { useState } from 'react';

import { setToken, whoami, type WhoAmI } from '../api';

type Props = {
  onSuccess: (user: WhoAmI) => void;
};

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
