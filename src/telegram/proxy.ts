import { proxyTransportFromUrl, type TelegramTransport } from '@mtcute/node'

export type ProxyType = 'socks4' | 'socks5' | 'http' | 'https' | 'mtproxy'

export interface PublicProxyInfo {
  type: ProxyType
  host: string
  port: number
}

export interface ResolvedProxy {
  public: PublicProxyInfo
  transport: TelegramTransport
}

const DEFAULT_PORTS: Record<string, number> = {
  'socks4:': 1080,
  'socks5:': 1080,
  'http:': 80,
  'https:': 443,
}

const SUPPORTED_PROTOCOLS = new Set(['socks4:', 'socks5:', 'http:', 'https:'])

export function normalizeProxyUrl(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) {
    throw new Error('Proxy URL is empty.')
  }

  if (trimmed.startsWith('tg://proxy')) {
    return trimmed
  }

  if (/^https?:\/\/t\.me\/proxy(?:\?|$)/.test(trimmed)) {
    return trimmed
  }

  if (trimmed.startsWith('mtproxy://')) {
    const rest = trimmed.slice('mtproxy://'.length)
    const hashIdx = rest.indexOf('#')
    const qIdx = rest.indexOf('?')

    let hostPort = rest
    let secret: string | null = null

    if (hashIdx >= 0) {
      secret = rest.slice(hashIdx + 1)
      hostPort = rest.slice(0, hashIdx)
    } else if (qIdx >= 0) {
      const query = new URLSearchParams(rest.slice(qIdx + 1))
      secret = query.get('secret')
      hostPort = rest.slice(0, qIdx)
    }

    if (!secret) {
      throw new Error('MTProxy URL requires a secret (?secret= or #fragment).')
    }

    const colon = hostPort.lastIndexOf(':')
    if (colon <= 0) {
      throw new Error('MTProxy URL requires host:port.')
    }

    const server = hostPort.slice(0, colon)
    const port = Number(hostPort.slice(colon + 1))
    if (!server || !Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error('MTProxy URL requires a valid host:port.')
    }

    return `tg://proxy?server=${encodeURIComponent(server)}&port=${port}&secret=${encodeURIComponent(secret)}`
  }

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error(`Invalid proxy URL: ${trimmed}`)
  }

  if (!SUPPORTED_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(`Unsupported proxy protocol: ${parsed.protocol}`)
  }

  if (!parsed.hostname) {
    throw new Error('Proxy URL requires a host.')
  }

  const port = Number(parsed.port) || DEFAULT_PORTS[parsed.protocol]
  if (!port || port <= 0 || port > 65535) {
    throw new Error('Proxy URL requires a valid port.')
  }

  return trimmed
}

export function publicProxyFromUrl(raw: string): PublicProxyInfo {
  const normalized = normalizeProxyUrl(raw)

  if (normalized.startsWith('tg://proxy') || /\/proxy(?:\?|$)/.test(normalized)) {
    const parsed = normalized.startsWith('tg://')
      ? new URL(`https://placeholder/${normalized.slice(5)}`)
      : new URL(normalized)
    const server = parsed.searchParams.get('server')
    const port = Number(parsed.searchParams.get('port'))
    if (!server || !Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error('Invalid MTProxy URL.')
    }
    return { type: 'mtproxy', host: server, port }
  }

  const parsed = new URL(normalized)
  const type = parsed.protocol.replace(':', '') as ProxyType
  const port = Number(parsed.port) || DEFAULT_PORTS[parsed.protocol]
  if (!parsed.hostname || !port || port <= 0 || port > 65535) {
    throw new Error('Proxy URL requires host and port.')
  }

  return { type, host: parsed.hostname, port }
}

export function parseProxyUrl(raw: string): ResolvedProxy {
  const normalized = normalizeProxyUrl(raw)
  return {
    public: publicProxyFromUrl(raw),
    transport: proxyTransportFromUrl(normalized),
  }
}
