import { Buffer } from 'node:buffer'
import { createHmac } from 'node:crypto'
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import { parse as parseURL, URLSearchParams } from 'node:url'
import { s } from '@sapphire/shapeshift'
import { parseLinkHeader } from '@web3-storage/parse-link-header'
import axios from 'axios'
import * as cheerio from 'cheerio'
import EventEmitter from 'eventemitter3'
import { ReasonPhrases, StatusCodes } from 'http-status-codes'

interface Events {
  listening: []
  error: [error: Error]
  denied: [hub: string, topic: string]

  subscribe: [hub: string, topic: string, leaseSeconds: number]
  unsubscribe: [hub: string, topic: string]

  feed: [hub: string, topic: string, body: string]
}

export interface Options {
  callbackURL: string
  secret: string
}

export class WebSub extends EventEmitter<Events> {
  private readonly callbackURL: string
  private readonly secret: string
  private server: Server | undefined

  public constructor(options: Options) {
    super()

    this.callbackURL = s.string.url().parse(options.callbackURL)
    this.secret = s.string.lengthGreaterThan(0).parse(options.secret)
  }

  public get listen() {
    if (this.server === undefined) {
      this.server = createServer(async (request, response) =>
        this._handleRequest(request, response),
      )

      this.server.on('listening', () => this.emit('listening'))
      this.server.on('error', error => this.emit('error', error))
    }

    return this.server.listen.bind(this.server)
  }

  public async subscribe(url: string, leaseSeconds?: number) {
    const { hub, topic } = await this._discover(url)
    return this._handleSubscribe('subscribe', hub, topic, leaseSeconds)
  }

  public async unsubscribe(url: string) {
    const { hub, topic } = await this._discover(url)
    if (!hub) return this._handleSubscribe('unsubscribe', hub, topic)
  }

  private async _discover(
    url: string,
  ): Promise<{ hub: string; topic: string }> {
    const resp = await axios.get(url)

    const links = parseLinkHeader(resp.headers.link)
    if (links?.hub.url) {
      const hub = links.hub.url
      const topic = links.self.url ?? url

      return { hub, topic }
    }

    const contentType = resp.headers['content-type']
    const isHTML = contentType.startsWith('text/html')
    const isXML = contentType.startsWith('text/xml')

    if (isHTML || isXML) {
      const $ = cheerio.load(resp.data, { xml: isXML })

      const hub = $('link[rel="hub"]').eq(0).attr('href')
      if (hub) {
        const topic = $('link[rel="self"]').eq(0).attr('href') ?? url
        return { hub, topic }
      }

      const atomHub = $('atom\\:link[rel="hub"]').eq(0).attr('href')
      if (atomHub) {
        const topic = $('atom\\:link[rel="self"]').eq(0).attr('href') ?? url
        return { hub: atomHub, topic }
      }
    }

    throw new Error('Failed to discover hub!')
  }

  private _hmacKey(topic: string): string {
    return createHmac('sha1', this.secret).update(topic, 'utf8').digest('hex')
  }

  private async _handleSubscribe(
    mode: 'subscribe' | 'unsubscribe',
    rawHub: string,
    rawTopic: string,
    rawLeaseSeconds = 0,
  ) {
    if (this.server === undefined) {
      throw new Error('you must call .listen() before (un)subscribing')
    }

    const hub = s.string.url().parse(rawHub)
    const topic = s.string.lengthGreaterThan(0).parse(rawTopic)
    const leaseSeconds = s.number.parse(rawLeaseSeconds)

    const parameters = new URLSearchParams()
    parameters.set('topic', topic)
    parameters.set('hub', hub)

    const secret = this._hmacKey(topic)
    const form = new URLSearchParams()

    const query = parameters.toString()
    const callbackURL = `${this.callbackURL}?${query}`

    form.set('hub.verify', 'async')
    form.set('hub.mode', mode)
    form.set('hub.topic', topic)
    form.set('hub.secret', secret)
    form.set('hub.callback', callbackURL)
    if (mode === 'subscribe') {
      form.set('hub.lease_seconds', leaseSeconds.toString())
    }

    await axios.post(hub, form)
  }

  private async _handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      switch (request.method) {
        case 'GET': {
          await this._handleGET(request, response)
          return
        }

        case 'POST': {
          await this._handlePOST(request, response)
          return
        }

        default: {
          response.writeHead(StatusCodes.METHOD_NOT_ALLOWED)
          response.write(ReasonPhrases.METHOD_NOT_ALLOWED)

          response.end()
          break
        }
      }
    } catch (error: unknown) {
      if (error instanceof Error) {
        this.emit('error', error)
      }
    }
  }

  private async _parseBody(
    request: IncomingMessage,
    key: string,
    algorithm: string,
    signature: string,
  ): Promise<{ body: string; valid: boolean }> {
    return new Promise((resolve, reject) => {
      const chunks: any[] = []
      const hmac = createHmac(algorithm.toLowerCase(), key)

      request.on('error', error => reject(error))
      request.on('data', chunk => chunks.push(chunk))

      request.on('end', () => {
        const body = Buffer.concat(chunks).toString()
        const digest = hmac.update(body, 'utf8').digest('hex')

        const valid = digest.toLowerCase() === signature.toLowerCase()
        resolve({ body, valid })
      })
    })
  }

  private async _handleGET(
    request: IncomingMessage,
    resp: ServerResponse,
  ): Promise<void> {
    if (!request.url) {
      resp.writeHead(StatusCodes.BAD_REQUEST)
      resp.write(ReasonPhrases.BAD_REQUEST)

      resp.end()
      return
    }

    const { query } = parseURL(request.url, true, true)
    const hub = Array.isArray(query.hub) ? query.hub[0] : query.hub
    const topic = Array.isArray(query['hub.topic'])
      ? query['hub.topic'][0]
      : query['hub.topic']

    const mode = Array.isArray(query['hub.mode'])
      ? query['hub.mode'][0]
      : query['hub.mode']

    const challenge = Array.isArray(query['hub.challenge'])
      ? query['hub.challenge'][0]
      : query['hub.challenge']

    if (!hub || !topic || !mode) {
      resp.writeHead(StatusCodes.BAD_REQUEST)
      resp.write(ReasonPhrases.BAD_REQUEST)

      resp.end()
      return
    }

    switch (mode) {
      case 'denied': {
        resp.writeHead(StatusCodes.OK)
        resp.write(challenge ?? 'OK')
        resp.end()

        this.emit('denied', hub, topic)
        return
      }

      case 'subscribe':
      case 'unsubscribe': {
        resp.writeHead(StatusCodes.OK)
        resp.write(challenge ?? 'OK')
        resp.end()

        if (mode === 'subscribe') {
          const lease = Array.isArray(query['hub.lease_seconds'])
            ? query['hub.lease_seconds'][0]
            : query['hub.lease_seconds']

          const leaseSeconds = Number.parseInt(lease ?? '0', 10)
          this.emit('subscribe', hub, topic, leaseSeconds)
        } else {
          this.emit('unsubscribe', hub, topic)
        }

        return
      }

      default: {
        resp.writeHead(StatusCodes.FORBIDDEN)
        resp.write(ReasonPhrases.FORBIDDEN)

        resp.end()
        break
      }
    }
  }

  private async _handlePOST(
    request: IncomingMessage,
    resp: ServerResponse,
  ): Promise<void> {
    if (!request.url) {
      resp.writeHead(StatusCodes.BAD_REQUEST)
      resp.write(ReasonPhrases.BAD_REQUEST)

      resp.end()
      return
    }

    if (!request.headers['x-hub-signature']) {
      resp.writeHead(StatusCodes.FORBIDDEN)
      resp.write(ReasonPhrases.FORBIDDEN)

      resp.end()
      return
    }

    const { query } = parseURL(request.url, true, true)
    const hub = Array.isArray(query.hub) ? query.hub[0] : query.hub
    const topic = Array.isArray(query.topic) ? query.topic[0] : query.topic

    if (!hub || !topic) {
      resp.writeHead(StatusCodes.BAD_REQUEST)
      resp.write(ReasonPhrases.BAD_REQUEST)

      resp.end()
      return
    }

    const sigHeader = request.headers['x-hub-signature'] as
      | string[]
      | string
      | undefined

    const signature = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader
    if (!signature) {
      resp.writeHead(StatusCodes.ACCEPTED)
      resp.write(ReasonPhrases.ACCEPTED)

      resp.end()
      return
    }

    const [algorithm, sig] = signature.split('=')
    const secret = this._hmacKey(topic)

    const { body, valid } = await this._parseBody(
      request,
      secret,
      algorithm,
      sig,
    )

    if (!valid) {
      resp.writeHead(StatusCodes.ACCEPTED)
      resp.write(ReasonPhrases.ACCEPTED)

      resp.end()
      return
    }

    resp.writeHead(StatusCodes.NO_CONTENT)
    resp.end()

    this.emit('feed', hub, topic, body)
  }
}
