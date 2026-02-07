import { useState, useEffect } from 'react';
import { Dashboard } from './pages/Dashboard';
import { Chat } from './pages/Chat';
import { Config } from './pages/Config';
import { Tools } from './pages/Tools';
import './styles.css';

type Route =
  | { page: 'dashboard' }
  | { page: 'chat'; sessionKey?: string; sessionId?: string }
  | { page: 'config' }
  | { page: 'tools' };

function parseHash(): Route {
  const hash = window.location.hash.slice(1);
  if (hash.startsWith('/chat')) {
    const params = new URLSearchParams(hash.split('?')[1] ?? '');
    return {
      page: 'chat',
      sessionKey: params.get('key') ?? undefined,
      sessionId: params.get('session') ?? undefined,
    };
  }
  if (hash.startsWith('/config')) {
    return { page: 'config' };
  }
  if (hash.startsWith('/tools')) {
    return { page: 'tools' };
  }
  return { page: 'dashboard' };
}

export function App() {
  const [route, setRoute] = useState<Route>(parseHash);

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  return (
    <div className="app">
      <header className="app-header">
        <a href="#/" className="app-title">autonomous-agent</a>
        <nav>
          <a href="#/" className={route.page === 'dashboard' ? 'active' : ''}>Dashboard</a>
          <a href="#/tools" className={route.page === 'tools' ? 'active' : ''}>Tools</a>
          <a href="#/chat" className={route.page === 'chat' ? 'active' : ''}>New Chat</a>
          <a href="#/config" className={route.page === 'config' ? 'active' : ''}>Config</a>
        </nav>
      </header>
      <main className="app-main">
        {route.page === 'dashboard' && <Dashboard />}
        {route.page === 'chat' && (
          <Chat sessionKey={route.sessionKey} sessionId={route.sessionId} />
        )}
        {route.page === 'tools' && <Tools />}
        {route.page === 'config' && <Config />}
      </main>
    </div>
  );
}
