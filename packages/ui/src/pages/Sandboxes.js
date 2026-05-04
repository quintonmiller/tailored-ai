import { jsxs as _jsxs, jsx as _jsx } from "react/jsx-runtime";
import { useEffect, useState } from "react";
import { fetchSandboxes, killSandbox } from "../api";
export function Sandboxes() {
    const [sandboxes, setSandboxes] = useState([]);
    const [error, setError] = useState(null);
    const [reloadTick, setReloadTick] = useState(0);
    useEffect(() => {
        let cancelled = false;
        function load() {
            fetchSandboxes()
                .then((res) => {
                if (!cancelled) {
                    setSandboxes(res.sandboxes);
                    setError(null);
                }
            })
                .catch((e) => {
                if (!cancelled)
                    setError(e.message);
            });
        }
        load();
        const id = setInterval(load, 3000);
        return () => {
            cancelled = true;
            clearInterval(id);
        };
    }, [reloadTick]);
    async function handleKill(id) {
        if (!confirm(`Kill sandbox ${id}? This will force-cleanup and may leave the running agent loop without a sandbox.`)) {
            return;
        }
        await killSandbox(id);
        setReloadTick((n) => n + 1);
    }
    return (_jsxs("div", { className: "tools-page", children: [_jsx("div", { className: "tools-header", children: _jsxs("h2", { children: ["Active sandboxes (", sandboxes.length, ")"] }) }), error && _jsx("div", { className: "config-error", children: error }), sandboxes.length === 0 && !error && (_jsx("div", { className: "empty-state", children: "No active sandboxes. They appear while an agent loop is running." })), _jsx("div", { className: "sandbox-grid", children: sandboxes.map((s) => (_jsxs("div", { className: "sandbox-card", children: [_jsxs("div", { className: "sandbox-card-header", children: [_jsx("span", { className: `sandbox-kind sandbox-kind-${s.kind}`, children: s.kind }), _jsx("span", { className: "sandbox-id", children: s.id }), s.kind !== "host" && (_jsx("button", { type: "button", className: "btn-danger", onClick: () => handleKill(s.id), children: "Kill" }))] }), _jsxs("dl", { className: "sandbox-meta", children: [_jsx("dt", { children: "Agent" }), _jsx("dd", { children: s.agentName ?? "(default)" }), _jsx("dt", { children: "Session" }), _jsx("dd", { children: s.sessionId ?? "—" }), _jsx("dt", { children: "cwd" }), _jsx("dd", { children: s.cwd }), _jsx("dt", { children: "Started" }), _jsx("dd", { children: new Date(s.startedAt).toLocaleString() })] })] }, s.id))) })] }));
}
