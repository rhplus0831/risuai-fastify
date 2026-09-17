import { resolve } from 'node:path'

const SAVE_MUTATION_LIMIT = 4
const ASSET_STAGING_LIMIT = 4

export class MaintenanceBusyError extends Error {
  readonly statusCode = 503
  readonly code = 'maintenance_busy'

  constructor() {
    super('maintenance_busy')
    this.name = 'MaintenanceBusyError'
  }
}

export interface MaintenanceLease {
  readonly kind: string
  readonly signal: AbortSignal
  release(): void
}

type LeaseCategory = 'exclusive' | 'save' | 'staging' | 'gc'

/**
 * Admission is immediate: callers either own a lease or receive maintenance_busy.
 * An aborted lease remains owned until its caller finishes cleanup and releases it.
 */
export class MaintenanceCoordinator {
  private readonly shutdown = new AbortController()
  private readonly leases = new Map<MaintenanceLease, LeaseCategory>()
  private state: 'open' | 'closing' | 'closed' = 'open'
  private exclusive: MaintenanceLease | undefined
  private saveMutations = 0
  private assetStaging = 0
  private gc: MaintenanceLease | undefined
  private activity = 0
  private protection = 0
  private closePromise: Promise<void> | undefined
  private resolveClose: (() => void) | undefined

  /** Cancels intake that does not yet own live assets or a maintenance lease. */
  get shutdownSignal(): AbortSignal {
    return this.shutdown.signal
  }

  get activityVersion(): number {
    return this.activity
  }

  get protectionVersion(): number {
    return this.protection
  }

  get isClosed(): boolean {
    return this.state === 'closed'
  }

  get isClosing(): boolean {
    return this.state === 'closing'
  }

  beginExclusive(kind: string, signal?: AbortSignal): MaintenanceLease {
    this.assertAdmission(signal)
    if (this.leases.size !== 0) throw new MaintenanceBusyError()
    return this.acquire('exclusive', kind, signal)
  }

  beginSaveMutation(signal?: AbortSignal): MaintenanceLease {
    this.assertAdmission(signal)
    if (this.exclusive || this.saveMutations >= SAVE_MUTATION_LIMIT) throw new MaintenanceBusyError()
    return this.acquire('save', 'save_mutation', signal)
  }

  beginAssetStaging(signal?: AbortSignal): MaintenanceLease {
    this.assertAdmission(signal)
    if (this.exclusive || this.assetStaging >= ASSET_STAGING_LIMIT) throw new MaintenanceBusyError()
    return this.acquire('staging', 'asset_staging', signal)
  }

  beginGc(signal?: AbortSignal): MaintenanceLease | undefined {
    if (this.state !== 'open' || this.gc || this.isReclamationBlocked()) return undefined
    this.assertAdmission(signal)
    return this.acquire('gc', 'asset_gc', signal)
  }

  isReclamationBlocked(): boolean {
    return this.state !== 'open' || this.exclusive !== undefined || this.assetStaging !== 0
  }

  assertExclusive(lease: MaintenanceLease): void {
    if (this.exclusive !== lease || this.leases.get(lease) !== 'exclusive') {
      throw new Error('invalid_maintenance_lease')
    }
  }

  noteAssetActivity(): void {
    this.activity += 1
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.state = 'closing'
    this.protection += 1
    // Install the drain promise before aborting: abort handlers can release leases.
    this.closePromise = new Promise<void>((resolveDrain) => {
      this.resolveClose = resolveDrain
    })
    this.shutdown.abort()
    this.finishDrain()
    return this.closePromise
  }

  private assertAdmission(signal?: AbortSignal): void {
    if (this.state !== 'open') throw new MaintenanceBusyError()
    signal?.throwIfAborted()
  }

  private acquire(category: LeaseCategory, kind: string, signal?: AbortSignal): MaintenanceLease {
    const lease: MaintenanceLease = Object.freeze({
      kind,
      signal: signal ? AbortSignal.any([this.shutdown.signal, signal]) : this.shutdown.signal,
      release: () => {
        if (!this.leases.delete(lease)) return
        if (category === 'exclusive') this.exclusive = undefined
        if (category === 'save') this.saveMutations -= 1
        if (category === 'staging') this.assetStaging -= 1
        if (category === 'gc') this.gc = undefined
        if (category !== 'save') this.protection += 1
        this.finishDrain()
      },
    })
    this.leases.set(lease, category)
    if (category === 'exclusive') this.exclusive = lease
    if (category === 'save') this.saveMutations += 1
    if (category === 'staging') this.assetStaging += 1
    if (category === 'gc') this.gc = lease
    if (category !== 'save') this.protection += 1
    return lease
  }

  private finishDrain(): void {
    if (this.state !== 'closing' || this.leases.size !== 0) return
    this.state = 'closed'
    this.resolveClose?.()
    this.resolveClose = undefined
  }
}

const coordinators = new Map<string, MaintenanceCoordinator>()

export function getMaintenanceCoordinator(dataDir: string): MaintenanceCoordinator {
  const key = resolve(dataDir)
  let coordinator = coordinators.get(key)
  if (!coordinator) {
    coordinator = new MaintenanceCoordinator()
    coordinators.set(key, coordinator)
  }
  return coordinator
}

/** App startup may reopen a directory only after the previous owner has drained. */
export function openMaintenance(dataDir: string): MaintenanceCoordinator {
  const coordinator = getMaintenanceCoordinator(dataDir)
  if (coordinator.isClosing) throw new MaintenanceBusyError()
  if (!coordinator.isClosed) return coordinator
  const replacement = new MaintenanceCoordinator()
  coordinators.set(resolve(dataDir), replacement)
  return replacement
}

/** Retain the closed coordinator so late repository calls cannot reopen admission. */
export function closeMaintenance(dataDir: string): Promise<void> {
  return getMaintenanceCoordinator(dataDir).close()
}
