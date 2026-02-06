import { jsxs as _jsxs, jsx as _jsx } from "react/jsx-runtime";
import { useState } from 'react';
export function ContextFiles(props) {
    const { data } = props;
    if (data.files.length === 0) {
        return _jsxs("div", { className: "empty-state", children: ["No context files in ", data.directory] });
    }
    return (_jsx("div", { className: "context-list", children: data.files.map((f) => (_jsx(ContextFileItem, { name: f.name, content: f.content }, f.name))) }));
}
function ContextFileItem(props) {
    const [open, setOpen] = useState(false);
    return (_jsxs("div", { className: "context-file", children: [_jsxs("button", { className: "context-file-header", onClick: () => setOpen(!open), children: [_jsx("span", { className: "context-chevron", children: open ? '\u25BE' : '\u25B8' }), _jsx("span", { children: props.name })] }), open && _jsx("pre", { className: "context-file-content", children: props.content })] }));
}
