import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
export function ToolCard(props) {
    const { tool } = props;
    const schema = tool.parameters;
    const paramEntries = Object.entries(schema.properties ?? {});
    return (_jsxs("div", { className: "tool-card", children: [_jsx("div", { className: "tool-card-name", children: tool.name }), _jsx("div", { className: "tool-card-desc", children: tool.description }), paramEntries.length > 0 && (_jsxs("div", { className: "tool-card-params", children: [_jsx("div", { className: "tool-card-params-title", children: "Parameters" }), paramEntries.map(([name, schema]) => (_jsxs("div", { className: "tool-param", children: [_jsx("code", { children: name }), schema.type && _jsx("span", { className: "tool-param-type", children: schema.type }), schema.description && _jsx("span", { className: "tool-param-desc", children: schema.description })] }, name)))] }))] }));
}
