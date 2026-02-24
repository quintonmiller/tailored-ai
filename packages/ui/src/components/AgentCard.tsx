import type { AgentInfo, SessionActivity } from "../api";

export function AgentCard(props: { name: string; agent: AgentInfo; activity?: SessionActivity }) {
  const { name, agent, activity } = props;
  const isActive = activity?.status === "active";

  return (
    <div className="agent-card">
      <div className="agent-name">
        <span className={`status-dot ${activity?.status ?? "idle"}`} style={{ marginRight: 7, flexShrink: 0 }} />
        {name}
        {isActive && activity?.description && (
          <span className="agent-activity-desc">{activity.description}</span>
        )}
      </div>
      {agent.description && (
        <div className="agent-field">
          <span className="agent-description">{agent.description}</span>
        </div>
      )}
      {agent.model && (
        <div className="agent-field">
          <span className="agent-label">Model</span>
          <span>{agent.model}</span>
        </div>
      )}
      {agent.tools && agent.tools.length > 0 && (
        <div className="agent-field">
          <span className="agent-label">Tools</span>
          <span>{agent.tools.join(", ")}</span>
        </div>
      )}
      {agent.temperature !== undefined && (
        <div className="agent-field">
          <span className="agent-label">Temperature</span>
          <span>{agent.temperature}</span>
        </div>
      )}
      {agent.instructions && !agent.description && (
        <div className="agent-field">
          <span className="agent-label">Instructions</span>
          <span className="agent-instructions">{agent.instructions}</span>
        </div>
      )}
    </div>
  );
}
