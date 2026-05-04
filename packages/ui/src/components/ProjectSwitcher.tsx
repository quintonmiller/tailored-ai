import { useEffect, useState } from "react";
import { fetchProjects, getActiveProjectId, setActiveProjectId, type ProjectWithCounts } from "../api";

/**
 * Header dropdown that scopes the UI to a registered project. Selection is
 * persisted to localStorage; child components that want to react listen for
 * the `tai:active-project-change` window event (or simply call
 * `getActiveProjectId()` on next render).
 */
export function ProjectSwitcher() {
  const [projects, setProjects] = useState<ProjectWithCounts[]>([]);
  const [active, setActive] = useState<string | null>(getActiveProjectId());
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetchProjects({ status: "active", limit: 50 })
      .then((res) => setProjects(res.projects))
      .catch(() => setProjects([]))
      .finally(() => setLoaded(true));
  }, []);

  useEffect(() => {
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<string | null>).detail;
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

  return (
    <select
      className="project-switcher"
      value={active ?? ""}
      onChange={(e) => {
        const v = e.target.value;
        if (v === "") {
          setActiveProjectId(null);
          setActive(null);
        } else {
          setActiveProjectId(v);
          setActive(v);
        }
      }}
      title="Filter UI by project"
    >
      <option value="">All projects</option>
      <option value="global">Global only</option>
      <optgroup label="Projects">
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.title}
          </option>
        ))}
      </optgroup>
    </select>
  );
}
