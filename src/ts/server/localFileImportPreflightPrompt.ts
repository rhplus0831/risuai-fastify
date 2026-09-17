import { language } from 'src/lang'
import { alertClear, alertConfirm, alertError, alertInput } from '../alert'
import { isClientWriteOperationCurrent } from '../clientWriteOperation'
import { ImportPasswordInvalid, ImportPasswordRequired, inspectLocalImport } from './localFilePreflight'

export async function prepareLocalFileImport(
  file: Blob,
  fileName: string,
  kind: 'character' | 'module',
  generation: number,
) {
  const isCurrent = () => isClientWriteOperationCurrent(generation)
  let password: string | undefined
  if (!isCurrent()) return null
  try {
    let inspection: Awaited<ReturnType<typeof inspectLocalImport>>
    try {
      inspection = await inspectLocalImport(file, fileName, kind)
    } catch (error) {
      if (!(error instanceof ImportPasswordRequired)) throw error
      if (!isCurrent()) return null
      alertClear()
      const entered = await alertInput(language.inputCardPassword)
      if (!isCurrent()) return null
      if (!entered) {
        alertClear()
        return null
      }
      password = entered
      inspection = await inspectLocalImport(file, fileName, kind, password)
    }
    if (!isCurrent()) return null
    if (inspection.lowLevelAccess) {
      alertClear()
      const confirmed = await alertConfirm(language.lowLevelAccessConfirm)
      if (!isCurrent()) return null
      if (!confirmed) {
        alertClear()
        return null
      }
    }
    return {
      stream: true as const,
      allowLowLevelAccess: inspection.lowLevelAccess,
      ...(password === undefined ? {} : { password }),
    }
  } catch (error) {
    if (isCurrent())
      alertError(error instanceof ImportPasswordInvalid ? language.errors.wrongPassword : language.errors.noData)
    return null
  }
}
