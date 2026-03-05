// @catscompany/bot-sdk — barrel export

export { CatsBot } from './bot';
export { MessageContext } from './context';
export { FileUploader } from './uploader';

export {
  parseTopic,
  buildP2PTopic,
  uidToNumber,
  numberToUid,
  type TopicInfo,
} from './topic';

export {
  CatsBotError,
  ConnectionError,
  HandshakeError,
  ProtocolError,
  RateLimitError,
  UploadError,
} from './errors';

export type {
  // Client messages
  MsgClientHi,
  MsgClientAcc,
  MsgClientLogin,
  MsgClientSub,
  MsgClientPub,
  MsgClientGet,
  MsgClientSet,
  MsgClientDel,
  MsgClientNote,
  MsgClientFriend,
  ClientMessage,
  // Server messages
  MsgServerCtrl,
  MsgServerData,
  MsgServerPres,
  MsgServerMeta,
  MsgServerInfo,
  MsgServerFriend,
  ServerMessage,
  // Rich content
  RichContentImage,
  RichContentFile,
  RichContentLinkPreview,
  RichContentCard,
  RichContent,
  MessageContent,
  // Upload
  UploadResult,
  // Config & events
  CatsBotConfig,
  BotEventMap,
} from './types';
