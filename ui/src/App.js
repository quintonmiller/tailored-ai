import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useEffect } from 'react';
import { Dashboard } from './pages/Dashboard';
import { Chat } from './pages/Chat';
import { Config } from './pages/Config';
import './styles.css';
function parseHash() {
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
    return { page: 'dashboard' };
}
export function App() {
    const [route, setRoute] = useState(parseHash);
    useEffect(() => {
        const onHash = () => setRoute(parseHash());
        window.addEventListener('hashchange', onHash);
        return () => window.removeEventListener('hashchange', onHash);
    }, []);
    return (_jsxs("div", { className: "app", children: [_jsxs("header", { className: "app-header", children: [_jsx("a", { href: "#/", className: "app-title", children: "autonomous-agent" }), _jsxs("nav", { children: [_jsx("a", { href: "#/", children: "Dashboard" }), _jsx("a", { href: "#/chat", children: "New Chat" }), _jsx("a", { href: "#/config", children: "Config" })] })] }), _jsxs("main", { className: "app-main", children: [route.page === 'dashboard' && _jsx(Dashboard, {}), route.page === 'chat' && (_jsx(Chat, { sessionKey: route.sessionKey, sessionId: route.sessionId })), route.page === 'config' && _jsx(Config, {})] })] }));
}
