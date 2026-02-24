import type { ToolInfo } from "../api";

export function ToolCard(props: { tool: ToolInfo }) {
  const { tool } = props;
  const schema = tool.parameters as {
    properties?: Record<string, { type?: string; description?: string; enum?: string[] }>;
  };
  const paramEntries = Object.entries(schema.properties ?? {});

  return (
    <div className="tool-card">
      <div className="tool-card-name">{tool.name}</div>
      <div className="tool-card-desc">{tool.description}</div>
      {paramEntries.length > 0 && (
        <div className="tool-card-params">
          <div className="tool-card-params-title">Parameters</div>
          {paramEntries.map(([name, schema]) => (
            <div key={name} className="tool-param">
              <code>{name}</code>
              {schema.type && <span className="tool-param-type">{schema.type}</span>}
              {schema.description && <span className="tool-param-desc">{schema.description}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
