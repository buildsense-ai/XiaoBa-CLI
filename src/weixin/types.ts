export interface WeixinConfig {
  token: string;
  baseUrl: string;
  cdnBaseUrl: string;
  stateDir?: string;
}

export interface WeixinMessage {
  message_id: string;
  from: { id: string };
  chat: { id: string };
  text?: string;
  context_token: string;
  item_list?: MessageItem[];
}

export interface MessageItem {
  type: number;
  text_item?: { text: string };
  image_item?: ImageItem;
  file_item?: FileItem;
}

export interface ImageItem {
  media?: CDNMedia;
  aeskey?: string;
  url?: string;
}

export interface FileItem {
  media?: CDNMedia;
  file_name?: string;
  len?: string;
}

export interface CDNMedia {
  encrypt_query_param?: string;
  aes_key?: string;
  encrypt_type?: number;
}
