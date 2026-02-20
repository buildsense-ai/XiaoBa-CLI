declare module '@catscompany/bot-sdk' {
  export class CatsBot {
    constructor(config: any);
    [key: string]: any;
  }
  export interface MessageContext {
    [key: string]: any;
  }
}
