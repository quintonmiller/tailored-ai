import { useState, useEffect } from 'react';
import { fetchConfig, saveConfig } from '../api';
import { StatusBar } from '../components/StatusBar';

export function Config() {
  const [content, setContent] = useState('');
  const [path, setPath] = useState('');
  const [status, setStatus] = useState<{ type: 'idle' | 'saving' | 'saved' | 'error'; message?: string }>({ type: 'idle' });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchConfig()
      .then((data) => {
        setContent(data.content);
        setPath(data.path);
      })
      .catch((e) => setError(e.message));
  }, []);

  async function handleSave() {
    setStatus({ type: 'saving' });
    try {
      const result = await saveConfig(content);
      if (result.error) {
        setStatus({ type: 'error', message: result.error });
      } else {
        setStatus({ type: 'saved', message: result.message });
        setTimeout(() => setStatus({ type: 'idle' }), 4000);
      }
    } catch (e) {
      setStatus({ type: 'error', message: (e as Error).message });
    }
  }

  return (
    <div className="config-page">
      <div className="config-header">
        <div>
          <h2>Configuration</h2>
          <span className="config-path">{path}</span>
        </div>
        <div className="config-actions">
          {status.type === 'saved' && <span className="config-saved">{status.message}</span>}
          {status.type === 'error' && <span className="config-error">{status.message}</span>}
          <button
            className="config-save-btn"
            onClick={handleSave}
            disabled={status.type === 'saving'}
          >
            {status.type === 'saving' ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
      <textarea
        className="config-editor"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        spellCheck={false}
      />
      <StatusBar connected={!error} error={error} />
    </div>
  );
}
