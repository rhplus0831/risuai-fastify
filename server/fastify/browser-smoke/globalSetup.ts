import { randomUUID } from 'node:crypto'
import { resetFastBootstrapArtifactOutputs } from './fastBootstrapIntegrationArtifact.js'

export default function globalSetup(): void {
  resetFastBootstrapArtifactOutputs()
  process.env.RISU_FAST_BOOTSTRAP_ARTIFACT_RUN_ID = randomUUID()
}
