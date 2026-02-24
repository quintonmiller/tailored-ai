import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
export function StatusBar(props) {
    return (_jsxs("div", { className: "status-bar", children: [_jsx("div", { className: `status-dot ${props.connected ? "" : "error"}` }), props.error ?? (props.connected ? "Connected" : "Disconnected")] }));
}
