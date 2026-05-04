import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from "react";
import { fetchProjects, getActiveProjectId, setActiveProjectId } from "../api";
/**
 * Header dropdown that scopes the UI to a registered project. Selection is
 * persisted to localStorage; child components that want to react listen for
 * the `tai:active-project-change` window event (or simply call
 * `getActiveProjectId()` on next render).
 */
export function ProjectSwitcher() {
    const [projects, setProjects] = useState([]);
    const [active, setActive] = useState(getActiveProjectId());
    const [loaded, setLoaded] = useState(false);
    useEffect(() => {
        fetchProjects({ status: "active", limit: 50 })
            .then((res) => setProjects(res.projects))
            .catch(() => setProjects([]))
            .finally(() => setLoaded(true));
    }, []);
    useEffect(() => {
        const onChange = (e) => {
            const detail = e.detail;
            setActive(detail ?? null);
        };
        window.addEventListener("tai:active-project-change", onChange);
        return () => window.removeEventListener("tai:active-project-change", onChange);
    }, []);
    if (!loaded || projects.length === 0) {
        // Don't render anything if no projects are registered — avoids visual noise
        // for users running in pure global mode.
        return null;
    }
    return (_jsxs("select", { className: "project-switcher", value: active ?? "", onChange: (e) => {
            const v = e.target.value;
            if (v === "") {
                setActiveProjectId(null);
                setActive(null);
            }
            else {
                setActiveProjectId(v);
                setActive(v);
            }
        }, title: "Filter UI by project", children: [_jsx("option", { value: "", children: "All projects" }), _jsx("option", { value: "global", children: "Global only" }), _jsx("optgroup", { label: "Projects", children: projects.map((p) => (_jsx("option", { value: p.id, children: p.title }, p.id))) })] }));
}
