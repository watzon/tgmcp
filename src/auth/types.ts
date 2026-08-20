import type { PublicProxyInfo } from '../telegram/proxy'

export type AuthPhase =
  | 'need_credentials'
  | 'need_login'
  | 'sending_code'
  | 'pending_code'
  | 'pending_qr'
  | 'ready'
  | 'owner_mismatch'

export interface PublicAuthStatus {
  phase: AuthPhase
  ready: boolean
  hasCredentials: boolean
  apiHash: string | null
  ownerId: string
  account: { id: string; name: string; username: string | null } | null
  proxy: PublicProxyInfo | null
  pendingPhone: string | null
  qrUrl: string | null
  qrExpires: string | null
  authError: string | null
  preferred: 'browser' | 'agent'
  hint: string
}

export interface PendingLogin {
  phone: string
  phoneCodeHash: string
}
