import { jsxs as _jsxs, jsx as _jsx } from "react/jsx-runtime";
import { useState, useEffect } from 'react';
import { fetchTools } from '../api';
import { ToolCard } from '../components/ToolCard';
export function Tools() {
    const [tools, setTools] = useState([]);
    const [error, setError] = useState(null);
    useEffect(() => {
        fetchTools()
            .then(setTools)
            .catch((e) => setError(e.message));
    }, []);
    return (_jsxs("div", { className: "tools-page", children: [_jsxs("h2", { children: ["Tools (", tools.length, ")"] }), error && _jsxs("div", { className: "empty-state", children: ["Error: ", error] }), tools.length === 0 && !error && _jsx("div", { className: "empty-state", children: "No tools loaded." }), _jsx("div", { className: "tools-grid", children: tools.map((t) => (_jsx(ToolCard, { tool: t }, t.name))) })] }));
}
