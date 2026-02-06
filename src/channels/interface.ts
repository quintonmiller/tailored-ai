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

  onMessage(handler: (msg: IncomingMessage) => void): void;
  send(target: string, content: string): Promise<void>;
}
