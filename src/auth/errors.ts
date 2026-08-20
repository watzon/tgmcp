export const CONNECT_TIMEOUT_MS = 15_000
export const SEND_CODE_TIMEOUT_MS = 30_000
export const QR_URL_TIMEOUT_MS = 30_000

const RECOVERABLE_RESUME_ERRORS = new Set([
  'AUTH_KEY_UNREGISTERED',
  'SESSION_PASSWORD_NEEDED',
  'SESSION_REVOKED',
  'USER_DEACTIVATED',
  'USER_DEACTIVATED_BAN',
])

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function rpcErrorText(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null
  const text = (err as { text?: unknown }).text
  return typeof text === 'string' ? text : null
}

export function isPasswordNeeded(err: unknown): boolean {
  const text = rpcErrorText(err)
  if (text === 'SESSION_PASSWORD_NEEDED') return true
  const message = errorText(err)
  return message.includes('SESSION_PASSWORD_NEEDED')
}

export function isRecoverableResumeError(err: unknown): boolean {
  const text = rpcErrorText(err)
  if (text && RECOVERABLE_RESUME_ERRORS.has(text)) return true
  const message = errorText(err)
  return (
    message.includes('AUTH_KEY_UNREGISTERED') ||
    message.includes('SESSION_PASSWORD_NEEDED') ||
    message.includes('SESSION_REVOKED') ||
    message.includes('USER_DEACTIVATED')
  )
}

export function formatAuthError(err: unknown): string {
  if (err instanceof Error && err.name === 'AbortError') {
    return 'Telegram request was cancelled or timed out.'
  }
  const text = rpcErrorText(err)
  if (text) return `Telegram error: ${text}`
  return errorText(err)
}

export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}
