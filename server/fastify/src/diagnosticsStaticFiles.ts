import fs from 'node:fs'
import path from 'node:path'
import type { AppConfig } from './config.js'

function canonicalExistingPath(file: string): string | undefined {
  try {
    return fs.realpathSync(file)
  } catch {
    return undefined
  }
}

/** Also guards sendFile/index fallback, where static root placement alone is insufficient. */
export function allowDiagnosticStaticFile(
  config: Pick<AppConfig, 'dataDir' | 'supportDiagnostics'>,
  pathname: string,
  root: string,
): boolean {
  try {
    const file = fs.realpathSync(path.join(root, decodeURIComponent(pathname)))
    const directory = path.join(fs.realpathSync(config.dataDir), 'diagnostics')
    const privateDirectory = canonicalExistingPath(directory) ?? directory
    const relative = path.relative(privateDirectory, file)
    if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)))
      return false
    const verifier = config.supportDiagnostics?.verifierFile
    if (verifier && file === (canonicalExistingPath(verifier) ?? path.resolve(verifier))) return false
    return true
  } catch {
    // Missing, malformed, or unresolvable files cannot become a secret-file fallback.
    return false
  }
}
