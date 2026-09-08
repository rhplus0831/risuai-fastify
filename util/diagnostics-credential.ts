import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertSupportDiagnosticsConfig, loadConfig } from '../server/fastify/src/config.js'
import {
  mintSupportDiagnosticsCredential,
  revokeSupportDiagnosticsCredential,
  rotateSupportDiagnosticsCredential,
  SupportDiagnosticsCredentialError,
} from '../server/fastify/src/supportDiagnosticsAuth.js'

/** Operator-only lifecycle tool. Environment selects fixed files; arguments never carry tokens. */
export async function runDiagnosticsCredentialCli(
  args: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  output: { stdout: (text: string) => void; stderr: (text: string) => void } = {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  },
): Promise<number> {
  const [command, credentialId] = args
  if (
    (command !== 'mint' && command !== 'rotate' && command !== 'revoke') ||
    (command === 'mint' ? args.length !== 1 : args.length !== 2 || !/^[a-f0-9]{32}$/.test(credentialId))
  ) {
    output.stderr('diagnostics-credential: invalid-command\n')
    return 1
  }
  const verifierFile = env.RISU_SUPPORT_DIAGNOSTICS_VERIFIER
  const credentialFile = env.RISU_DIAGNOSTICS_REMOTE_CONFIG
  const origin = env.RISU_DIAGNOSTICS_REMOTE_ORIGIN
  if (!verifierFile || (command !== 'revoke' && (!credentialFile || !origin))) {
    output.stderr('diagnostics-credential: invalid-configuration\n')
    return 1
  }
  try {
    // Apply the same file/static/backup exclusions as the server, even when
    // provisioning for a server whose support endpoint is currently disabled.
    const config = loadConfig({ ...env, RISU_SUPPORT_DIAGNOSTICS: '1' })
    if (command !== 'revoke') {
      assertSupportDiagnosticsConfig({
        ...config,
        supportDiagnostics: { enabled: true, verifierFile: credentialFile },
      })
    }
  } catch {
    output.stderr('diagnostics-credential: invalid-configuration\n')
    return 1
  }
  try {
    if (command === 'revoke') {
      await revokeSupportDiagnosticsCredential(verifierFile, credentialId)
    } else {
      const options = { verifierFile, credentialFile: credentialFile!, origin: origin! }
      if (command === 'mint') await mintSupportDiagnosticsCredential(options)
      else await rotateSupportDiagnosticsCredential({ ...options, credentialId })
    }
    output.stdout(
      `diagnostics-credential: ${command === 'mint' ? 'created' : command === 'rotate' ? 'rotated' : 'revoked'}\n`,
    )
    return 0
  } catch (cause) {
    const category = cause instanceof SupportDiagnosticsCredentialError ? cause.code : 'storage-unavailable'
    output.stderr(`diagnostics-credential: ${category}\n`)
    return 1
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runDiagnosticsCredentialCli()
}
