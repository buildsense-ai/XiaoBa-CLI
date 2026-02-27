"use strict";
// @catscompany/bot-sdk — barrel export
Object.defineProperty(exports, "__esModule", { value: true });
exports.UploadError = exports.RateLimitError = exports.ProtocolError = exports.HandshakeError = exports.ConnectionError = exports.CatsBotError = exports.numberToUid = exports.uidToNumber = exports.buildP2PTopic = exports.parseTopic = exports.FileUploader = exports.MessageContext = exports.CatsBot = void 0;
var bot_1 = require("./bot");
Object.defineProperty(exports, "CatsBot", { enumerable: true, get: function () { return bot_1.CatsBot; } });
var context_1 = require("./context");
Object.defineProperty(exports, "MessageContext", { enumerable: true, get: function () { return context_1.MessageContext; } });
var uploader_1 = require("./uploader");
Object.defineProperty(exports, "FileUploader", { enumerable: true, get: function () { return uploader_1.FileUploader; } });
var topic_1 = require("./topic");
Object.defineProperty(exports, "parseTopic", { enumerable: true, get: function () { return topic_1.parseTopic; } });
Object.defineProperty(exports, "buildP2PTopic", { enumerable: true, get: function () { return topic_1.buildP2PTopic; } });
Object.defineProperty(exports, "uidToNumber", { enumerable: true, get: function () { return topic_1.uidToNumber; } });
Object.defineProperty(exports, "numberToUid", { enumerable: true, get: function () { return topic_1.numberToUid; } });
var errors_1 = require("./errors");
Object.defineProperty(exports, "CatsBotError", { enumerable: true, get: function () { return errors_1.CatsBotError; } });
Object.defineProperty(exports, "ConnectionError", { enumerable: true, get: function () { return errors_1.ConnectionError; } });
Object.defineProperty(exports, "HandshakeError", { enumerable: true, get: function () { return errors_1.HandshakeError; } });
Object.defineProperty(exports, "ProtocolError", { enumerable: true, get: function () { return errors_1.ProtocolError; } });
Object.defineProperty(exports, "RateLimitError", { enumerable: true, get: function () { return errors_1.RateLimitError; } });
Object.defineProperty(exports, "UploadError", { enumerable: true, get: function () { return errors_1.UploadError; } });
//# sourceMappingURL=index.js.map