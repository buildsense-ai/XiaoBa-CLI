export interface MsgClientHi {
    id?: string;
    ua?: string;
    ver?: string;
    lang?: string;
}
export interface MsgClientAcc {
    id?: string;
    user?: string;
    scheme?: string;
    secret?: string;
    desc?: Record<string, string>;
}
export interface MsgClientLogin {
    id?: string;
    scheme?: string;
    secret?: string;
}
export interface MsgClientSub {
    id?: string;
    topic: string;
}
export interface MsgClientPub {
    id?: string;
    topic: string;
    content: unknown;
    reply_to?: number;
}
export interface MsgClientGet {
    id?: string;
    topic: string;
    what?: string;
    seq?: number;
}
export interface MsgClientSet {
    id?: string;
    topic: string;
    desc?: unknown;
}
export interface MsgClientDel {
    id?: string;
    topic?: string;
    what?: string;
}
export interface MsgClientNote {
    topic: string;
    what: 'read' | 'recv' | 'kp';
    seq?: number;
}
export interface MsgClientFriend {
    id?: string;
    action: 'request' | 'accept' | 'reject' | 'block' | 'remove';
    user_id: number;
    msg?: string;
}
export interface ClientMessage {
    hi?: MsgClientHi;
    acc?: MsgClientAcc;
    login?: MsgClientLogin;
    sub?: MsgClientSub;
    pub?: MsgClientPub;
    get?: MsgClientGet;
    set?: MsgClientSet;
    del?: MsgClientDel;
    note?: MsgClientNote;
    friend?: MsgClientFriend;
}
export interface MsgServerCtrl {
    id?: string;
    topic?: string;
    code: number;
    text?: string;
    params?: Record<string, unknown>;
}
export interface MsgServerData {
    topic: string;
    from?: string;
    seq: number;
    content: unknown;
    reply_to?: number;
}
export interface MsgServerPres {
    topic: string;
    what: 'on' | 'off' | 'msg' | 'upd';
    src?: string;
}
export interface MsgServerMeta {
    id?: string;
    topic: string;
    desc?: unknown;
    sub?: unknown;
}
export interface MsgServerInfo {
    topic: string;
    from: string;
    what: 'read' | 'recv' | 'kp';
    seq?: number;
}
export interface MsgServerFriend {
    action: 'request' | 'accepted' | 'rejected' | 'blocked' | 'removed';
    from: number;
    to: number;
    msg?: string;
}
export interface ServerMessage {
    ctrl?: MsgServerCtrl;
    data?: MsgServerData;
    pres?: MsgServerPres;
    meta?: MsgServerMeta;
    info?: MsgServerInfo;
    friend?: MsgServerFriend;
}
export interface RichContentImage {
    type: 'image';
    payload: {
        url: string;
        width?: number;
        height?: number;
        name?: string;
        size?: number;
    };
}
export interface RichContentFile {
    type: 'file';
    payload: {
        url: string;
        name: string;
        size: number;
        mime_type?: string;
    };
}
export interface RichContentLinkPreview {
    type: 'link_preview';
    payload: {
        url: string;
        title?: string;
        description?: string;
        image_url?: string;
    };
}
export interface RichContentCard {
    type: 'card';
    payload: {
        title: string;
        description?: string;
        image_url?: string;
        actions?: Array<{
            label: string;
            url?: string;
            action?: string;
        }>;
    };
}
export type RichContent = RichContentImage | RichContentFile | RichContentLinkPreview | RichContentCard;
export type MessageContent = string | RichContent;
export interface UploadResult {
    file_key: string;
    url: string;
    name: string;
    size: number;
    type: string;
}
export interface CatsBotConfig {
    /** WebSocket server URL, e.g. "ws://localhost:6061/v0/channels" */
    serverUrl: string;
    /** Bot API key, e.g. "cc_1a_abc123..." */
    apiKey: string;
    /** HTTP base URL for REST endpoints (upload). Defaults to deriving from serverUrl. */
    httpBaseUrl?: string;
    /** Delay in ms before reconnecting after disconnect. Default: 3000 */
    reconnectDelay?: number;
    /** Timeout in ms for server pings before forcing reconnect. Default: 70000 */
    pingTimeout?: number;
}
import type { MessageContext } from './context';
export interface BotEventMap {
    ready: (uid: string) => void;
    message: (ctx: MessageContext) => void;
    presence: (pres: MsgServerPres) => void;
    typing: (info: MsgServerInfo) => void;
    read: (info: MsgServerInfo) => void;
    ctrl: (ctrl: MsgServerCtrl) => void;
    disconnect: (code: number, reason: string) => void;
    error: (err: Error) => void;
    reconnecting: (attempt: number) => void;
}
//# sourceMappingURL=types.d.ts.map
