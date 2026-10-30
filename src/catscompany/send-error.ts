// Kept independent of CatsClient so transport consumers need no client/runtime
// dependency cycle merely to distinguish lost RPC results from tool failures.
export type CatsSendErrorKind = 'transport' | 'ack' | 'timeout';

export class CatsSendError extends Error {
  public readonly clientMsgID?: string;
  public readonly retryableWithHttp: boolean;

  constructor(
    public readonly kind: CatsSendErrorKind,
    message: string,
    public readonly code?: number,
    options: { clientMsgID?: string; retryableWithHttp?: boolean } = {},
  ) {
    super(message);
    this.name = 'CatsSendError';
    this.clientMsgID = options.clientMsgID;
    this.retryableWithHttp = options.retryableWithHttp ?? false;
  }
}
