import { useState } from "react";
import { type ContextData, fetchContextFile } from "../api";

export function ContextFiles(props: { data: ContextData }) {
  const { data } = props;
  const hasGlobal = data.global.length > 0;
  const agentNames = Object.keys(data.agents);

  if (!hasGlobal && agentNames.length === 0) {
    return <div className="empty-state">No context files in {data.directory}</div>;
  }

  return (
    <div className="context-list">
      {hasGlobal && (
        <div className="context-section">
          <h3>Global</h3>
          {data.global.map((name) => (
            <ContextFileItem key={name} name={name} scope="global" />
          ))}
        </div>
      )}
      {agentNames.map((agent) => (
        <div key={agent} className="context-section">
          <h3>{agent}</h3>
          {data.agents[agent].map((name) => (
            <ContextFileItem key={name} name={name} scope={agent} />
          ))}
        </div>
      ))}
    </div>
  );
}

function ContextFileItem(props: { name: string; scope: string }) {
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const toggle = async () => {
    if (!open && content === null) {
      setLoading(true);
      try {
        const data = await fetchContextFile(props.name, props.scope);
        setContent(data.content);
      } catch {
        setContent("[Error loading file]");
      }
      setLoading(false);
    }
    setOpen(!open);
  };

  return (
    <div className="context-file">
      <button type="button" className="context-file-header" onClick={toggle}>
        <span className="context-chevron">{open ? "\u25BE" : "\u25B8"}</span>
        <span>{props.name}</span>
        {loading && <span className="context-loading">loading...</span>}
      </button>
      {open && content !== null && <pre className="context-file-content">{content}</pre>}
    </div>
  );
}
