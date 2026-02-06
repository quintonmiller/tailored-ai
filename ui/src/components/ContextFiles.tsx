import { useState } from 'react';
import type { ContextData } from '../api';

export function ContextFiles(props: { data: ContextData }) {
  const { data } = props;

  if (data.files.length === 0) {
    return <div className="empty-state">No context files in {data.directory}</div>;
  }

  return (
    <div className="context-list">
      {data.files.map((f) => (
        <ContextFileItem key={f.name} name={f.name} content={f.content} />
      ))}
    </div>
  );
}

function ContextFileItem(props: { name: string; content: string }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="context-file">
      <button className="context-file-header" onClick={() => setOpen(!open)}>
        <span className="context-chevron">{open ? '\u25BE' : '\u25B8'}</span>
        <span>{props.name}</span>
      </button>
      {open && <pre className="context-file-content">{props.content}</pre>}
    </div>
  );
}
