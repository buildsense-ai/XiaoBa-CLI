export declare class CatsBotError extends Error {
    constructor(message: string);
}
export declare class ConnectionError extends CatsBotError {
    constructor(message: string);
}
export declare class HandshakeError extends CatsBotError {
    constructor(message: string);
}
export declare class ProtocolError extends CatsBotError {
    readonly code: number;
    constructor(code: number, message?: string);
}
export declare class RateLimitError extends CatsBotError {
    constructor(message?: string);
}
export declare class UploadError extends CatsBotError {
    readonly statusCode?: number;
    constructor(message: string, statusCode?: number);
}
//# sourceMappingURL=errors.d.ts.map