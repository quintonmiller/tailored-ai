export interface IncomingMessage {
  id: string;
  channelId: string;
  authorId: string;
  authorName: string;
  content: string;
  isDM: boolean;
  isMention: boolean;
  replyTo?: string;
}

export interface Channel {
  id: string;
  type: string;

  connect(): Promise<void>;
  disconnect(): Promise<void>;

  send(target: string, content: string): Promise<void>;

  /**
   * Optional capability: signal the user that the agent is working on a reply
   * (typing indicator, reaction, status update — transport's choice). Returns
   * a "stop" function the caller invokes once the work is finished; calling
   * stop more than once must be safe. Channels that have no equivalent
   * concept simply omit the method.
   */
  indicateWorking?(target: string): () => void;
}
