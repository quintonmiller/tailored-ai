import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { marked } from "marked";
import { useMemo, useState } from "react";
marked.setOptions({
    breaks: true,
    gfm: true,
});
const TRUNCATE_LENGTH = 500;
export function MessageBubble(props) {
    const { role, content, toolCalls } = props.message;
    // Assistant message that only triggered tool calls (no text content)
    if (role === "assistant" && !content && toolCalls?.length) {
        return (_jsx("div", { className: "tool-calls", children: toolCalls.map((tc) => (_jsxs("div", { className: "tool-call-bubble", children: [_jsx("span", { className: "tool-call-name", children: tc.name }), _jsx("pre", { className: "tool-call-args", children: formatArgs(tc.arguments) })] }, tc.id))) }));
    }
    // Assistant message with both content and tool calls
    if (role === "assistant" && content && toolCalls?.length) {
        return (_jsxs(_Fragment, { children: [_jsx(AssistantBubble, { content: content }), _jsx("div", { className: "tool-calls", children: toolCalls.map((tc) => (_jsxs("div", { className: "tool-call-bubble", children: [_jsx("span", { className: "tool-call-name", children: tc.name }), _jsx("pre", { className: "tool-call-args", children: formatArgs(tc.arguments) })] }, tc.id))) })] }));
    }
    // Regular assistant message — render as markdown
    if (role === "assistant" && content) {
        return _jsx(AssistantBubble, { content: content });
    }
    // Tool result
    if (role === "tool") {
        return _jsx(ToolResultBubble, { content: content ?? "" });
    }
    // User message
    if (role === "user") {
        return _jsx("div", { className: "message-bubble user", children: content ?? "" });
    }
    // System — hidden
    return null;
}
function ToolResultBubble(props) {
    const { content } = props;
    const [expanded, setExpanded] = useState(false);
    const [copied, setCopied] = useState(false);
    const isTruncatable = content.length > TRUNCATE_LENGTH;
    const displayContent = isTruncatable && !expanded ? `${content.slice(0, TRUNCATE_LENGTH)}...` : content;
    function handleCopy() {
        navigator.clipboard.writeText(content).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        }).catch(() => { });
    }
    return (_jsxs("div", { className: "message-bubble tool", children: [_jsx("pre", { className: "tool-result-content", children: displayContent }), (isTruncatable || content.length > 100) && (_jsxs("div", { className: "tool-result-actions", children: [isTruncatable && (_jsx("button", { type: "button", className: "tool-result-btn", onClick: () => setExpanded(!expanded), children: expanded ? "Collapse" : `Expand (${content.length} chars)` })), _jsx("button", { type: "button", className: "tool-result-btn", onClick: handleCopy, children: copied ? "Copied" : "Copy" })] }))] }));
}
function AssistantBubble(props) {
    const html = useMemo(() => marked.parse(props.content), [props.content]);
    return _jsx("div", { className: "message-bubble assistant markdown-body", dangerouslySetInnerHTML: { __html: html } });
}
function formatArgs(args) {
    const entries = Object.entries(args);
    if (entries.length === 0)
        return "()";
    if (entries.length === 1) {
        const [k, v] = entries[0];
        const s = typeof v === "string" ? v : JSON.stringify(v);
        return s.length > 120 ? `${k}: ${s.slice(0, 120)}...` : `${k}: ${s}`;
    }
    return JSON.stringify(args, null, 2);
}
