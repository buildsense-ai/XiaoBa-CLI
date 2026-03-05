// Custom error classes for the Cats Company Bot SDK.

export class CatsBotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatsBotError';
  }
}

export class ConnectionError extends CatsBotError {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectionError';
  }
}

export class HandshakeError extends CatsBotError {
  public readonly statusCode?: number;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = 'HandshakeError';
    this.statusCode = statusCode;
  }
}

export class ProtocolError extends CatsBotError {
  public readonly code: number;

  constructor(code: number, message?: string) {
    super(message ?? `Protocol error: code ${code}`);
    this.name = 'ProtocolError';
    this.code = code;
  }
}

export class RateLimitError extends CatsBotError {
  constructor(message?: string) {
    super(message ?? 'Rate limit exceeded');
    this.name = 'RateLimitError';
  }
}

export class UploadError extends CatsBotError {
  public readonly statusCode?: number;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = 'UploadError';
    this.statusCode = statusCode;
  }
}
