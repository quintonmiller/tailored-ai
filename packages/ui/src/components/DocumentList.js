import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useCallback, useEffect, useState } from "react";
import { createDocumentApi, fetchDocuments, } from "../api";
function relativeTime(iso) {
    const diff = Date.now() - new Date(iso + "Z").getTime();
    const mins = Math.floor(diff / 60_000);
    if (mins < 1)
        return "just now";
    if (mins < 60)
        return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24)
        return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
}
export function DocumentList({ projectId, }) {
    const [docs, setDocs] = useState([]);
    const [search, setSearch] = useState("");
    const [showForm, setShowForm] = useState(false);
    const [formTitle, setFormTitle] = useState("");
    const [formContent, setFormContent] = useState("");
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const loadDocs = useCallback(async () => {
        try {
            const res = await fetchDocuments(projectId, search || undefined);
            setDocs(res);
        }
        catch (e) {
            setError(e.message);
        }
        finally {
            setLoading(false);
        }
    }, [projectId, search]);
    useEffect(() => {
        loadDocs();
    }, [loadDocs]);
    // Poll every 10s
    useEffect(() => {
        const id = setInterval(loadDocs, 10_000);
        return () => clearInterval(id);
    }, [loadDocs]);
    const handleCreate = async () => {
        if (!formTitle.trim())
            return;
        try {
            await createDocumentApi(projectId, {
                title: formTitle,
                content: formContent,
            });
            setShowForm(false);
            setFormTitle("");
            setFormContent("");
            await loadDocs();
        }
        catch (e) {
            setError(e.message);
        }
    };
    return (_jsxs("div", { children: [_jsxs("div", { className: "doc-list-header", children: [_jsx("input", { className: "tasks-search", placeholder: "Search documents...", value: search, onChange: (e) => setSearch(e.target.value) }), _jsx("button", { className: "tasks-new-btn", onClick: () => setShowForm(true), children: "+ New Document" })] }), error && (_jsxs("div", { className: "tasks-error", children: [error, _jsx("button", { className: "tasks-error-dismiss", onClick: () => setError(null), children: "x" })] })), showForm && (_jsx("div", { className: "tasks-form-overlay", onClick: () => setShowForm(false), children: _jsxs("div", { className: "tasks-form", onClick: (e) => e.stopPropagation(), children: [_jsx("h3", { children: "New Document" }), _jsxs("div", { className: "field-group", children: [_jsx("label", { className: "field-label", children: "Title" }), _jsx("input", { className: "field-input", value: formTitle, onChange: (e) => setFormTitle(e.target.value), onKeyDown: (e) => {
                                        if (e.key === "Enter" && !e.shiftKey)
                                            handleCreate();
                                    }, autoFocus: true })] }), _jsxs("div", { className: "field-group", children: [_jsx("label", { className: "field-label", children: "Content (Markdown)" }), _jsx("textarea", { className: "field-textarea", value: formContent, onChange: (e) => setFormContent(e.target.value), rows: 10, style: { minHeight: 200 } })] }), _jsxs("div", { className: "tasks-form-actions", children: [_jsx("button", { className: "tasks-cancel-btn", onClick: () => setShowForm(false), children: "Cancel" }), _jsx("button", { className: "tasks-submit-btn", onClick: handleCreate, disabled: !formTitle.trim(), children: "Create" })] })] }) })), loading ? (_jsxs("div", { className: "skeleton-list", children: [_jsx("div", { className: "skeleton-card" }), _jsx("div", { className: "skeleton-card" })] })) : docs.length === 0 ? (_jsxs("div", { className: "empty-state", children: ["No documents yet.", " ", _jsx("button", { className: "tasks-new-btn", onClick: () => setShowForm(true), children: "+ Create one" })] })) : (_jsx("div", { className: "doc-list", children: docs.map((d) => (_jsxs("a", { className: "doc-list-item", href: `#/projects/${projectId}/documents/${d.id}`, children: [_jsx("span", { className: "doc-list-title", children: d.title }), _jsx("span", { className: "doc-list-filename", children: d.filename }), _jsx("span", { className: "doc-list-time", children: relativeTime(d.updated_at) })] }, d.id))) }))] }));
}
