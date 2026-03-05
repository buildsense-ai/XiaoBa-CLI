"use strict";
// Custom error classes for the Cats Company Bot SDK.
Object.defineProperty(exports, "__esModule", { value: true });
exports.UploadError = exports.RateLimitError = exports.ProtocolError = exports.HandshakeError = exports.ConnectionError = exports.CatsBotError = void 0;
class CatsBotError extends Error {
    constructor(message) {
        super(message);
        this.name = 'CatsBotError';
    }
}
exports.CatsBotError = CatsBotError;
class ConnectionError extends CatsBotError {
    constructor(message) {
        super(message);
        this.name = 'ConnectionError';
    }
}
exports.ConnectionError = ConnectionError;
class HandshakeError extends CatsBotError {
    statusCode;
    constructor(message, statusCode) {
        super(message);
        this.name = 'HandshakeError';
        this.statusCode = statusCode;
    }
}
exports.HandshakeError = HandshakeError;
class ProtocolError extends CatsBotError {
    code;
    constructor(code, message) {
        super(message ?? `Protocol error: code ${code}`);
        this.name = 'ProtocolError';
        this.code = code;
    }
}
exports.ProtocolError = ProtocolError;
class RateLimitError extends CatsBotError {
    constructor(message) {
        super(message ?? 'Rate limit exceeded');
        this.name = 'RateLimitError';
    }
}
exports.RateLimitError = RateLimitError;
class UploadError extends CatsBotError {
    statusCode;
    constructor(message, statusCode) {
        super(message);
        this.name = 'UploadError';
        this.statusCode = statusCode;
    }
}
exports.UploadError = UploadError;
//# sourceMappingURL=errors.js.map