declare module 'websub' {
  import http from 'http'
  import { EventEmitter } from 'events'

  type WebSubOptions = {
    callbackURL: string
    secret: string
  }

  type SubscriptionCallback = {
    secret: string
    callbackURL: string
  }

  type DeniedEvent = {
    topic: string
    err: Error
  }

  type SubscribeEvent = {
    lease: number
    topic: string
    hub: string
  }

  type FeedEvent = {
    topic: string
    hub: string
    body: string
    headers: http.IncomingHttpHeaders
  }

  class WebSub extends EventEmitter {
    constructor (options?: WebSubOptions)

    public callbackURL: string
    public secret: string
    public server: http.Server
    public port: number

    public listen(port?: number, hostname?: string, backlog?: number, listeningListener?: Function): void

    private _createKey(topic: string): string
    private _setSubscription(mode: 'subscribe' | 'unsubscribe', topic: string, hub: string): Promise<SubscriptionCallback>

    public subscribe(topic: string, hub: string): Promise<SubscriptionCallback>
    public unsubscribe(topic: string, hub: string): Promise<SubscriptionCallback>

    private _onRequest(req: http.IncomingMessage, res: http.ServerResponse): void
    private _onError(error: Error): void
    private _handleGetRequest(req: http.IncomingMessage, res: http.ServerResponse): void
    private _handlePostRequest(req: http.IncomingMessage, res: http.ServerResponse): void
    private _parseBody(req: http.IncomingMessage, key: string, algo: string, signature: string): Promise<[string, boolean]>

    public on(event: 'listening', listener: () => void): this
    public on(event: 'error', listener: (err: Error) => void): this
    public on(event: 'denied', listener: (data: DeniedEvent) => void): this
    public on(event: 'subscribe' | 'unsubscribe', listener: (data: SubscribeEvent) => void): this
    public on(event: 'feed', listener: (data: FeedEvent) => void): this

    public once(event: 'listening', listener: () => void): this
    public once(event: 'error', listener: (err: Error) => void): this
    public once(event: 'denied', listener: (data: DeniedEvent) => void): this
    public once(event: 'subscribe' | 'unsubscribe', listener: (data: SubscribeEvent) => void): this
    public once(event: 'feed', listener: (data: FeedEvent) => void): this
  }

  export = WebSub
}