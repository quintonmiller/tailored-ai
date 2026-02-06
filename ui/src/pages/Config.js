import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useEffect } from 'react';
import { fetchConfig, saveConfig } from '../api';
import { StatusBar } from '../components/StatusBar';
export function Config() {
    const [content, setContent] = useState('');
    const [path, setPath] = useState('');
    const [status, setStatus] = useState({ type: 'idle' });
    const [error, setError] = useState(null);
    useEffect(() => {
        fetchConfig()
            .then((data) => {
            setContent(data.content);
            setPath(data.path);
        })
            .catch((e) => setError(e.message));
    }, []);
    async function handleSave() {
        setStatus({ type: 'saving' });
        try {
            const result = await saveConfig(content);
            if (result.error) {
                setStatus({ type: 'error', message: result.error });
            }
            else {
                setStatus({ type: 'saved', message: result.message });
                setTimeout(() => setStatus({ type: 'idle' }), 4000);
            }
        }
        catch (e) {
            setStatus({ type: 'error', message: e.message });
        }
    }
    return (_jsxs("div", { className: "config-page", children: [_jsxs("div", { className: "config-header", children: [_jsxs("div", { children: [_jsx("h2", { children: "Configuration" }), _jsx("span", { className: "config-path", children: path })] }), _jsxs("div", { className: "config-actions", children: [status.type === 'saved' && _jsx("span", { className: "config-saved", children: status.message }), status.type === 'error' && _jsx("span", { className: "config-error", children: status.message }), _jsx("button", { className: "config-save-btn", onClick: handleSave, disabled: status.type === 'saving', children: status.type === 'saving' ? 'Saving...' : 'Save' })] })] }), _jsx("textarea", { className: "config-editor", value: content, onChange: (e) => setContent(e.target.value), spellCheck: false }), _jsx(StatusBar, { connected: !error, error: error })] }));
}
