import { jsxs as _jsxs, jsx as _jsx } from "react/jsx-runtime";
import { useEffect, useMemo, useState } from "react";
import { fetchTools } from "../api";
import { ToolCard } from "../components/ToolCard";
export function Tools() {
    const [tools, setTools] = useState([]);
    const [error, setError] = useState(null);
    const [search, setSearch] = useState("");
    const [loading, setLoading] = useState(true);
    useEffect(() => {
        fetchTools()
            .then(setTools)
            .catch((e) => setError(e.message))
            .finally(() => setLoading(false));
    }, []);
    const filtered = useMemo(() => {
        if (!search.trim())
            return tools;
        const q = search.toLowerCase();
        return tools.filter((t) => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q));
    }, [tools, search]);
    return (_jsxs("div", { className: "tools-page", children: [_jsxs("div", { className: "tools-header", children: [_jsxs("h2", { children: ["Tools (", tools.length, ")"] }), tools.length > 0 && (_jsx("input", { className: "tools-search", type: "text", placeholder: "Filter tools...", value: search, onChange: (e) => setSearch(e.target.value) }))] }), loading && (_jsxs("div", { className: "skeleton-list", children: [_jsx("div", { className: "skeleton-card" }), _jsx("div", { className: "skeleton-card" }), _jsx("div", { className: "skeleton-card" })] })), error && _jsxs("div", { className: "empty-state", children: ["Error: ", error] }), !loading && tools.length === 0 && !error && _jsx("div", { className: "empty-state", children: "No tools loaded." }), search && filtered.length === 0 && _jsxs("div", { className: "empty-state", children: ["No tools match \"", search, "\""] }), _jsx("div", { className: "tools-grid", children: filtered.map((t) => (_jsx(ToolCard, { tool: t }, t.name))) })] }));
}
