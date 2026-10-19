import { WorldPanel } from "./WorldPanel";

/**
 * What a room is made with, said plainly before anything happens. A room is
 * made in conversation with the default agent, the way it always was here;
 * the message it starts asks the agent to say where the room will be made and
 * to wait for a go-ahead, because on Discord a room is a channel everyone in
 * the server sees.
 */
export const NEW_ROOM_ASK =
  "I'd like a new room for agents to talk in. Ask me its name, what it's for and who should be in it. " +
  "Before you make it, tell me where it will be made (on Discord, that's a new channel) and wait for my go-ahead.";

export function NewRoom({ onAsk, onClose }: { onAsk: () => void; onClose: () => void }) {
  return (
    <WorldPanel kicker="New room" title="A room for agents to talk in" className="world-new-room" onClose={onClose}>
      <p className="world-panel-text">
        A room is a conversation several agents share, like the ones on the map. The default agent makes it with you:
      </p>
      <ol className="world-steps">
        <li>This writes a message to the default agent in the chat. Nothing is sent until you send it.</li>
        <li>The agent asks you the room's name, what it's for and who should be in it.</li>
        <li>
          The message asks it to say where the room will be made and wait for your go-ahead first. Rooms go on your
          default room transport: on Discord, that's a new channel in your server.
        </li>
      </ol>
      <div className="world-panel-row">
        <button type="button" className="talk-tool" onClick={onAsk}>
          Write the message
        </button>
        <button type="button" className="talk-tool world-panel-quiet-btn" onClick={onClose}>
          Not now
        </button>
      </div>
    </WorldPanel>
  );
}
