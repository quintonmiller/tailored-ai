export function StatusBar(props: { connected: boolean; error?: string | null }) {
  return (
    <div className="status-bar">
      <div className={`status-dot ${props.connected ? "" : "error"}`} />
      {props.error ?? (props.connected ? "Connected" : "Disconnected")}
    </div>
  );
}
