import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { BRAND } from "../brand";
const LINKS = [
    {
        title: "Getting Started",
        description: "Installation, first run, and basic configuration.",
        href: `${BRAND.docs}#getting-started`,
    },
    {
        title: "Configuration",
        description: "Full reference for config.yaml options.",
        href: `${BRAND.docs}#configuration`,
    },
    {
        title: "Profiles & Delegation",
        description: "Named agent profiles, model overrides, and sub-agent delegation.",
        href: `${BRAND.docs}#profiles`,
    },
    {
        title: "Tools",
        description: "Built-in tools, custom tools, and how to add your own.",
        href: `${BRAND.docs}#tools`,
    },
    {
        title: "Cron Jobs",
        description: "Scheduled tasks, delivery channels, and hook configuration.",
        href: `${BRAND.docs}#cron`,
    },
    {
        title: "Webhooks",
        description: "HTTP webhook routes and message templating.",
        href: `${BRAND.docs}#webhooks`,
    },
    {
        title: "Hooks",
        description: "Before/after run hooks for profiles and cron jobs.",
        href: `${BRAND.docs}#hooks`,
    },
    {
        title: "API Reference",
        description: "HTTP API endpoints for programmatic access.",
        href: `${BRAND.docs}#api`,
    },
];
export function Help() {
    return (_jsxs("div", { className: "help-page", children: [_jsxs("div", { className: "help-hero", children: [_jsx("h1", { children: BRAND.name }), _jsx("p", { className: "help-tagline", children: BRAND.tagline })] }), _jsx("div", { className: "help-grid", children: LINKS.map((link) => (_jsxs("a", { href: link.href, target: "_blank", rel: "noopener noreferrer", className: "help-card", children: [_jsx("h3", { children: link.title }), _jsx("p", { children: link.description }), _jsx("span", { className: "help-card-arrow", children: "\u2192" })] }, link.title))) }), _jsxs("div", { className: "help-footer-links", children: [_jsx("a", { href: BRAND.github, target: "_blank", rel: "noopener noreferrer", children: "GitHub" }), _jsx("span", { className: "help-footer-dot" }), _jsx("a", { href: BRAND.website, target: "_blank", rel: "noopener noreferrer", children: "Website" }), _jsx("span", { className: "help-footer-dot" }), _jsx("a", { href: `${BRAND.github}/issues`, target: "_blank", rel: "noopener noreferrer", children: "Report an Issue" })] })] }));
}
