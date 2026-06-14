import { useEffect, useState } from 'react';
import { Navigate, NavLink, Route, Routes, useNavigate } from 'react-router-dom';

import { clearToken, getToken, whoami, type WhoAmI } from './api';
import { LoginPage } from './pages/Login';
import { DashboardPage } from './pages/Dashboard';
import { ConversationsPage } from './pages/Conversations';
import { ConversationDetailPage } from './pages/ConversationDetail';
import { UsersPage } from './pages/Users';
import { IncidentsPage } from './pages/Incidents';
import { SettingsPage } from './pages/Settings';

export function App() {
  const [state, setState] = useState<
    { kind: 'loading' } | { kind: 'out' } | { kind: 'in'; user: WhoAmI }
  >(() => (getToken() ? { kind: 'loading' } : { kind: 'out' }));

  useEffect(() => {
    if (state.kind !== 'loading') return;
    whoami()
      .then((user) => setState({ kind: 'in', user }))
      .catch(() => setState({ kind: 'out' }));
  }, [state.kind]);

  if (state.kind === 'loading') {
    return (
      <div className="login">
        <div className="spinner" />
      </div>
    );
  }
  if (state.kind === 'out') {
    return (
      <LoginPage
        onSuccess={(user) => setState({ kind: 'in', user })}
      />
    );
  }
  return (
    <AuthedLayout user={state.user} onLogout={() => setState({ kind: 'out' })} />
  );
}

function AuthedLayout({
  user,
  onLogout,
}: {
  user: WhoAmI;
  onLogout: () => void;
}) {
  const navigate = useNavigate();
  function handleLogout() {
    clearToken();
    onLogout();
    navigate('/login');
  }
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand-tag">MOVA</div>
        <h1>Admin</h1>
        <NavLink to="/dashboard" end>Дашборд</NavLink>
        <NavLink to="/calls">Дзвінки</NavLink>
        <NavLink to="/users">Користувачі</NavLink>
        <NavLink to="/incidents">Інциденти</NavLink>
        <NavLink to="/settings">Ключі</NavLink>
        <div className="spacer" />
        <div style={{ fontSize: 12, color: 'var(--mute)', padding: '8px 14px' }}>
          {user.email}
        </div>
        <button className="logout" onClick={handleLogout}>
          Вийти
        </button>
      </aside>
      <main className="main">
        <Routes>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/calls" element={<ConversationsPage />} />
          <Route path="/calls/:id" element={<ConversationDetailPage />} />
          <Route path="/users" element={<UsersPage />} />
          <Route path="/incidents" element={<IncidentsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </main>
    </div>
  );
}
