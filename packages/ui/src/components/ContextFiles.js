import { jsxs as _jsxs, jsx as _jsx } from "react/jsx-runtime";
import { useState } from "react";
import { fetchContextFile } from "../api";
export function ContextFiles(props) {
    const { data } = props;
    const hasGlobal = data.global.length > 0;
    const agentNames = Object.keys(data.agents);
    if (!hasGlobal && agentNames.length === 0) {
        return _jsxs("div", { className: "empty-state", children: ["No context files in ", data.directory] });
    }
    return (_jsxs("div", { className: "context-list", children: [hasGlobal && (_jsxs("div", { className: "context-section", children: [_jsx("h3", { children: "Global" }), data.global.map((name) => (_jsx(ContextFileItem, { name: name, scope: "global" }, name)))] })), agentNames.map((agent) => (_jsxs("div", { className: "context-section", children: [_jsx("h3", { children: agent }), data.agents[agent].map((name) => (_jsx(ContextFileItem, { name: name, scope: agent }, name)))] }, agent)))] }));
}
function ContextFileItem(props) {
    const [open, setOpen] = useState(false);
    const [content, setContent] = useState(null);
    const [loading, setLoading] = useState(false);
    const toggle = async () => {
        if (!open && content === null) {
            setLoading(true);
            try {
                const data = await fetchContextFile(props.name, props.scope);
                setContent(data.content);
            }
            catch {
                setContent("[Error loading file]");
            }
            setLoading(false);
        }
        setOpen(!open);
    };
    return (_jsxs("div", { className: "context-file", children: [_jsxs("button", { type: "button", className: "context-file-header", onClick: toggle, children: [_jsx("span", { className: "context-chevron", children: open ? "\u25BE" : "\u25B8" }), _jsx("span", { children: props.name }), loading && _jsx("span", { className: "context-loading", children: "loading..." })] }), open && content !== null && _jsx("pre", { className: "context-file-content", children: content })] }));
}
