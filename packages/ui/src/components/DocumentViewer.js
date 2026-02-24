import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { marked } from "marked";
import { useCallback, useEffect, useMemo, useState } from "react";
import { deleteDocumentApi, fetchDocument, updateDocumentApi, } from "../api";
marked.setOptions({ breaks: true, gfm: true });
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
export function DocumentViewer({ projectId, docId, }) {
    const [doc, setDoc] = useState(null);
    const [editing, setEditing] = useState(false);
    const [title, setTitle] = useState("");
    const [content, setContent] = useState("");
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const loadDoc = useCallback(async () => {
        try {
            const d = await fetchDocument(projectId, docId);
            setDoc(d);
            setTitle(d.title);
            setContent(d.content);
        }
        catch (e) {
            setError(e.message);
        }
        finally {
            setLoading(false);
        }
    }, [projectId, docId]);
    useEffect(() => {
        loadDoc();
    }, [loadDoc]);
    // Poll every 10s when not editing
    useEffect(() => {
        if (editing)
            return;
        const id = setInterval(loadDoc, 10_000);
        return () => clearInterval(id);
    }, [loadDoc, editing]);
    const handleSave = async () => {
        if (!doc)
            return;
        try {
            await updateDocumentApi(projectId, doc.id, { title, content });
            const updated = await fetchDocument(projectId, doc.id);
            setDoc(updated);
            setTitle(updated.title);
            setContent(updated.content);
            setEditing(false);
        }
        catch (e) {
            setError(e.message);
        }
    };
    const handleDelete = async () => {
        if (!doc)
            return;
        try {
            await deleteDocumentApi(projectId, doc.id);
            window.location.hash = `#/projects/${projectId}/documents`;
        }
        catch (e) {
            setError(e.message);
        }
    };
    const renderedHtml = useMemo(() => (doc ? marked.parse(doc.content) : ""), [doc]);
    const goBack = () => {
        window.location.hash = `#/projects/${projectId}/documents`;
    };
    if (loading) {
        return (_jsx("div", { className: "doc-page", children: _jsx("div", { className: "skeleton-card", style: { height: 200 } }) }));
    }
    if (!doc) {
        return (_jsx("div", { className: "doc-page", children: _jsxs("div", { className: "empty-state", children: ["Document not found.", " ", _jsx("button", { className: "tasks-edit-btn", onClick: goBack, children: "Back to documents" })] }) }));
    }
    return (_jsxs("div", { className: "doc-page", children: [error && (_jsxs("div", { className: "tasks-error", children: [error, _jsx("button", { className: "tasks-error-dismiss", onClick: () => setError(null), children: "x" })] })), _jsxs("div", { className: "doc-page-header", children: [_jsx("button", { className: "doc-back-btn", onClick: goBack, children: "Back" }), _jsx("div", { className: "doc-page-actions", children: editing ? (_jsxs(_Fragment, { children: [_jsx("button", { className: "tasks-submit-btn", onClick: handleSave, children: "Save" }), _jsx("button", { className: "tasks-cancel-btn", onClick: () => {
                                        setTitle(doc.title);
                                        setContent(doc.content);
                                        setEditing(false);
                                    }, children: "Cancel" })] })) : (_jsxs(_Fragment, { children: [_jsx("button", { className: "tasks-edit-btn", onClick: () => setEditing(true), children: "Edit" }), _jsx("button", { className: "tasks-delete-btn", onClick: handleDelete, children: "Delete" })] })) })] }), editing ? (_jsx("input", { className: "doc-page-title-input", value: title, onChange: (e) => setTitle(e.target.value), autoFocus: true })) : (_jsx("h2", { className: "doc-page-title", children: doc.title })), _jsxs("div", { className: "doc-page-meta", children: [_jsx("span", { children: doc.filename }), _jsx("span", { children: doc.id }), _jsx("span", { children: relativeTime(doc.updated_at) })] }), editing ? (_jsx("textarea", { className: "doc-editor", value: content, onChange: (e) => setContent(e.target.value) })) : (_jsx("div", { className: "doc-page-content markdown-body", dangerouslySetInnerHTML: { __html: renderedHtml } }))] }));
}
