import { captureClientWriteOperation, assertClientWriteOperation } from '../clientWriteOperation'
import { language } from 'src/lang'
import { alertError, alertInput, waitAlert } from '../alert'
import { activeWriterSessionHeader, handleActiveWriterStaleResponse } from '../server/activeWriterSession'
import { base64url, getKeypairStore, saveKeypairStore } from '../util'
import { resetBrowserDiagnosticsSession } from '../server/browserDiagnostics'

const ROUTES = {
  write: '/api/v1/storage/write',
  read: '/api/v1/storage/read',
  exists: '/api/v1/storage/exists',
  list: '/api/v1/storage/list',
  remove: '/api/v1/storage/remove',
  crypto: '/api/v1/auth/crypto',
  status: '/api/v1/auth/status',
  setPassword: '/api/v1/auth/setup',
  login: '/api/v1/auth/login',
}

type AuthStatus = 'unset' | 'incorrect' | 'success'
type PasswordAuthResponse = {
  authToken?: unknown
  error?: unknown
}

const FASTIFY_BROWSER_SMOKE_PASSWORD = 'risu-fastify-browser-smoke'
const SESSION_AUTH_PREFIX = 'session.'

function fastifyBrowserSmokePassword(): string | null {
  return import.meta.env.VITE_FASTIFY_BROWSER_SMOKE === 'TRUE' ? FASTIFY_BROWSER_SMOKE_PASSWORD : null
}

function subtleCrypto(): SubtleCrypto | null {
  return globalThis.crypto?.subtle ?? null
}

function clearSessionAuth(): void {
  try {
    if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem('risuauth')
  } catch {}
}

function isCurrentSessionAuth(token: string): boolean {
  const parts = token.split('.')
  if (parts.length !== 3 || !token.startsWith(SESSION_AUTH_PREFIX)) return false
  const expiresAt = Number.parseInt(parts[1] ?? '', 36)
  return Number.isSafeInteger(expiresAt) && expiresAt >= Math.floor(Date.now() / 1000)
}

function storedSessionAuth(): string | null {
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem('risuauth')?.startsWith(SESSION_AUTH_PREFIX)) {
      // Migrate away from the old persistent fallback token storage. The server
      // now expires these tokens too, but they should not survive a browser
      // session on insecure origins where WebCrypto is unavailable.
      localStorage.removeItem('risuauth')
    }
    if (typeof sessionStorage === 'undefined') return null
    const token = sessionStorage.getItem('risuauth')
    if (!token?.startsWith(SESSION_AUTH_PREFIX)) return null
    if (isCurrentSessionAuth(token)) return token
    sessionStorage.removeItem('risuauth')
    resetBrowserDiagnosticsSession()
    return null
  } catch {
    return null
  }
}

function saveSessionAuth(token: string): void {
  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem('risuauth', token)
    }
  } catch {}
}

async function fetchAuthStatus(assertion: string): Promise<AuthStatus> {
  const res = await fetch(ROUTES.status, {
    headers: { 'risu-auth': assertion },
  })
  if (res.status >= 200 && res.status < 300) {
    const body = (await res.json()) as { noPassword?: boolean; authorized?: boolean }
    if (body.noPassword) return 'unset'
    return body.authorized ? 'success' : 'incorrect'
  }
  return 'incorrect'
}

export class FastifyStorage {
  authChecked = false
  JSONStringlifyAndbase64Url(obj: any) {
    return base64url(Buffer.from(JSON.stringify(obj), 'utf-8'))
  }

  async createAuth() {
    const subtle = subtleCrypto()
    if (!subtle) {
      return storedSessionAuth() ?? ''
    }

    const keyPair = await this.getKeyPair()
    const date = Math.floor(Date.now() / 1000)

    const header = {
      alg: 'ES256',
      typ: 'JWT',
    }
    const payload = {
      iat: date,
      exp: date + 5 * 60, //5 minutes expiration
      pub: await subtle.exportKey('jwk', keyPair.publicKey),
    }
    const sig = await subtle.sign(
      {
        name: 'ECDSA',
        hash: 'SHA-256',
      },
      keyPair.privateKey,
      Buffer.from(this.JSONStringlifyAndbase64Url(header) + '.' + this.JSONStringlifyAndbase64Url(payload)),
    )
    const sigString = base64url(new Uint8Array(sig))
    return this.JSONStringlifyAndbase64Url(header) + '.' + this.JSONStringlifyAndbase64Url(payload) + '.' + sigString
  }

  async getProxyAuth() {
    await this.checkAuth()
    const auth = await this.createAuth()
    if (auth.startsWith(SESSION_AUTH_PREFIX)) {
      saveSessionAuth(auth)
    }
    return auth
  }

  async getKeyPair(): Promise<CryptoKeyPair> {
    const storedKey = await getKeypairStore('node')

    if (storedKey) {
      return storedKey
    }

    const subtle = subtleCrypto()
    if (!subtle) {
      throw new Error('WebCrypto is unavailable on this origin')
    }

    const keyPair = await subtle.generateKey(
      {
        name: 'ECDSA',
        namedCurve: 'P-256',
      },
      false,
      ['sign', 'verify'],
    )

    await saveKeypairStore('node', keyPair)

    return keyPair
  }

  async setItem(key: string, value: Uint8Array) {
    const operation = captureClientWriteOperation()
    await this.checkAuth()
    const auth = await this.createAuth()
    assertClientWriteOperation(operation)
    const da = await fetch(ROUTES.write, {
      method: 'POST',
      body: value as any,
      headers: {
        'content-type': 'application/octet-stream',
        'file-path': Buffer.from(key, 'utf-8').toString('hex'),
        'risu-auth': auth,
        ...activeWriterSessionHeader(),
      },
    })
    if (da.status < 200 || da.status >= 300) {
      const body = await da
        .clone()
        .json()
        .catch(() => null)
      handleActiveWriterStaleResponse(da, body, operation)
      throw 'setItem Error'
    }
    const data = await da.json()
    if (data.error) {
      throw data.error
    }
  }
  async getItem(key: string): Promise<Buffer> {
    await this.checkAuth()
    const da = await fetch(ROUTES.read, {
      method: 'GET',
      headers: {
        'file-path': Buffer.from(key, 'utf-8').toString('hex'),
        'risu-auth': await this.createAuth(),
      },
    })
    if (da.status < 200 || da.status >= 300) {
      throw 'getItem Error'
    }

    const data = Buffer.from(await da.arrayBuffer())
    if (data.length == 0) {
      return null
    }
    return data
  }
  async hasItem(key: string): Promise<boolean> {
    await this.checkAuth()
    const da = await fetch(ROUTES.exists, {
      method: 'GET',
      headers: {
        'file-path': Buffer.from(key, 'utf-8').toString('hex'),
        'risu-auth': await this.createAuth(),
      },
    })
    if (da.status < 200 || da.status >= 300) {
      throw 'existsItem Error'
    }
    const data = await da.json()
    if (data.error) {
      throw data.error
    }
    return data.exists === true
  }
  async keys(): Promise<string[]> {
    await this.checkAuth()
    const da = await fetch(ROUTES.list, {
      method: 'GET',
      headers: {
        'risu-auth': await this.createAuth(),
      },
    })
    if (da.status < 200 || da.status >= 300) {
      throw 'listItem Error'
    }
    const data = await da.json()
    if (data.error) {
      throw data.error
    }
    return data.content
  }
  async removeItem(key: string | string[]) {
    const operation = captureClientWriteOperation()
    await this.checkAuth()
    const auth = await this.createAuth()
    assertClientWriteOperation(operation)
    const hexKey = (k: string) => Buffer.from(k, 'utf-8').toString('hex')
    const filePath = Array.isArray(key) ? key.map(hexKey).join('$$') : hexKey(key)
    const da = await fetch(ROUTES.remove, {
      method: 'POST',
      headers: {
        'file-path': filePath,
        'risu-auth': auth,
        ...activeWriterSessionHeader(),
      },
    })
    if (da.status < 200 || da.status >= 300) {
      const body = await da
        .clone()
        .json()
        .catch(() => null)
      handleActiveWriterStaleResponse(da, body, operation)
      throw 'removeItem Error'
    }
    const data = await da.json()
    if (data.error) {
      throw data.error
    }
  }

  private async checkAuth() {
    const canUseWebCrypto = subtleCrypto() !== null
    // Session tokens are deliberately short-lived. A tab can outlive one, so
    // invalidate the cached auth decision before its next request and obtain a
    // fresh server-issued token through the normal login flow.
    if (!canUseWebCrypto && !storedSessionAuth()) {
      this.authChecked = false
      clearSessionAuth()
    }

    if (!this.authChecked) {
      const status = await fetchAuthStatus(await this.createAuth())

      if (status === 'unset') {
        const keypair = canUseWebCrypto ? await this.getKeyPair() : null
        const publicKey = keypair ? await subtleCrypto()!.exportKey('jwk', keypair.publicKey) : null
        const smokePassword = fastifyBrowserSmokePassword()
        const input = await digestPassword(smokePassword ?? (await alertInput(language.setNodePassword)))
        const s = await fetch(ROUTES.setPassword, {
          method: 'POST',
          body: JSON.stringify({
            password: input,
            ...(publicKey ? { publicKey } : { sessionAuth: true }),
          }),
          headers: {
            'content-type': 'application/json',
          },
        })
        const sessionAuth = await readPasswordAuthResponse(s, `Password setup failed (${s.status})`, !canUseWebCrypto)
        if (sessionAuth) {
          saveSessionAuth(sessionAuth)
        }
        this.authChecked = true
        return await this.createAuth()
      } else if (status === 'incorrect') {
        const keypair = canUseWebCrypto ? await this.getKeyPair() : null
        const publicKey = keypair ? await subtleCrypto()!.exportKey('jwk', keypair.publicKey) : null
        const smokePassword = fastifyBrowserSmokePassword()
        const input = await digestPassword(smokePassword ?? (await alertInput(language.inputNodePassword)))

        const s = await fetch(ROUTES.login, {
          method: 'POST',
          body: JSON.stringify({
            password: input,
            ...(publicKey ? { publicKey } : { sessionAuth: true }),
          }),
          headers: {
            'content-type': 'application/json',
          },
        })
        const sessionAuth = await readPasswordAuthResponse(s, `Login failed (${s.status})`, !canUseWebCrypto)
        if (sessionAuth) {
          saveSessionAuth(sessionAuth)
        }
        this.authChecked = true
        return await this.createAuth()
      } else {
        this.authChecked = true
      }
    }
  }

  listItem = this.keys
}

const sharedStorage = new FastifyStorage()

export async function getNodeServerProxyAuth() {
  return await sharedStorage.getProxyAuth()
}

/** Optional diagnostics never initiate setup/login, renew authority, or acquire writer ownership. */
export async function getNodeServerDiagnosticsAuth(): Promise<string | null> {
  if (!sharedStorage.authChecked) return null
  if (!subtleCrypto() && !storedSessionAuth()) return null
  return sharedStorage.createAuth()
}

/** Explicit reauthentication after authenticated reader resources were cleared. */
export function invalidateNodeServerProxyAuth(): void {
  resetBrowserDiagnosticsSession()
  sharedStorage.authChecked = false
  clearSessionAuth()
}

async function readPasswordAuthResponse(
  response: Response,
  fallbackMessage: string,
  requireSessionAuth: boolean,
): Promise<string | null> {
  let body: PasswordAuthResponse | null = null
  try {
    body = (await response.json()) as PasswordAuthResponse
  } catch {}

  if (response.status < 200 || response.status >= 300) {
    const message = typeof body?.error === 'string' ? body.error : fallbackMessage
    alertError(message)
    await waitAlert()
    throw message
  }

  if (!requireSessionAuth) return null

  if (typeof body?.authToken === 'string' && body.authToken.startsWith(SESSION_AUTH_PREFIX)) {
    return body.authToken
  }

  const message = 'Server did not return a LAN auth token'
  alertError(message)
  await waitAlert()
  throw message
}

async function digestPassword(message: string) {
  const response = await fetch(ROUTES.crypto, {
    body: JSON.stringify({
      data: message,
    }),
    headers: {
      'content-type': 'application/json',
    },
    method: 'POST',
  })

  if (response.status < 200 || response.status >= 300) {
    let message = `Password crypto failed (${response.status})`
    try {
      const body = await response.json()
      if (body?.error) {
        message = body.error
      }
    } catch {}
    throw message
  }
  const crypt = await response.text()

  return crypt
}
