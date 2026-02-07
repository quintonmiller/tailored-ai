import { jsxs as _jsxs, jsx as _jsx } from "react/jsx-runtime";
import { useState } from 'react';
export function ContextFiles(props) {
    const { data } = props;
    const hasGlobal = data.global.length > 0;
    const profileNames = Object.keys(data.profiles);
    if (!hasGlobal && profileNames.length === 0) {
        return _jsxs("div", { className: "empty-state", children: ["No context files in ", data.directory] });
    }
    return (_jsxs("div", { className: "context-list", children: [hasGlobal && (_jsxs("div", { className: "context-section", children: [_jsx("h3", { children: "Global" }), data.global.map((f) => (_jsx(ContextFileItem, { name: f.name, content: f.content }, f.name)))] })), profileNames.map((profile) => (_jsxs("div", { className: "context-section", children: [_jsx("h3", { children: profile }), data.profiles[profile].map((f) => (_jsx(ContextFileItem, { name: f.name, content: f.content }, f.name)))] }, profile)))] }));
}
function ContextFileItem(props) {
    const [open, setOpen] = useState(false);
    return (_jsxs("div", { className: "context-file", children: [_jsxs("button", { className: "context-file-header", onClick: () => setOpen(!open), children: [_jsx("span", { className: "context-chevron", children: open ? '\u25BE' : '\u25B8' }), _jsx("span", { children: props.name })] }), open && _jsx("pre", { className: "context-file-content", children: props.content })] }));
}
