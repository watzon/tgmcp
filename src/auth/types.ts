export type AuthPhase =
  | 'need_credentials'
  | 'need_login'
  | 'pending_code'
  | 'pending_qr'
  | 'ready'
  | 'owner_mismatch'

export interface PublicAuthStatus {
  phase: AuthPhase
  ready: boolean
  hasCredentials: boolean
  apiId: number | null
  apiHash: string | null
  ownerId: string
  account: { id: string; name: string; username: string | null } | null
  pendingPhone: string | null
  qrUrl: string | null
  qrExpires: string | null
  preferred: 'browser' | 'agent'
  hint: string
}

export interface PendingLogin {
  phone: string
  phoneCodeHash: string
}
