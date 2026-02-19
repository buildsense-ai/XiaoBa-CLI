declare module '@catscompany/bot-sdk' {
  export interface CatsBotOptions {
    serverUrl: string;
    apiKey: string;
    httpBaseUrl?: string;
  }

  export interface MessageContext {
    topic: string;
    from: string;
    seq: number;
    text: string;
    isGroup: boolean;
    content: unknown;
  }

  export class CatsBot {
    constructor(options: CatsBotOptions);
    on(event: 'ready', listener: (uid: string) => void): void;
    on(event: 'message', listener: (ctx: MessageContext) => void): void;
    on(event: 'reconnecting', listener: (attempt: number) => void): void;
    on(event: 'error', listener: (err: Error) => void): void;
    connect(): Promise<void>;
    disconnect(): void;
    sendMessage(topic: string, text: string): Promise<void>;
    uploadFile(filePath: string, type: 'image' | 'file'): Promise<string>;
    sendImage(topic: string, ref: string): Promise<void>;
    sendFile(topic: string, ref: string): Promise<void>;
    sendTyping(topic: string): void;
  }
}
