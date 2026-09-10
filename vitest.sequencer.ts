import { BaseSequencer, type TestSpecification } from 'vitest/node'

interface ProjectOrderedFile {
  project: { name: string; config: { sequence: { groupOrder: number } } }
}

export function interleaveTestProjects<T extends ProjectOrderedFile>(files: readonly T[]): T[] {
  const groups = new Map<number, Map<string, T[]>>()
  for (const file of files) {
    const { name, config } = file.project
    let projects = groups.get(config.sequence.groupOrder)
    if (!projects) groups.set(config.sequence.groupOrder, (projects = new Map()))
    let projectFiles = projects.get(name)
    if (!projectFiles) projects.set(name, (projectFiles = []))
    projectFiles.push(file)
  }

  const result: T[] = []
  for (const projects of groups.values()) {
    const queues = [...projects.values()]
    const longest = Math.max(...queues.map((queue) => queue.length))
    for (let index = 0; index < longest; index++) {
      for (const queue of queues) {
        if (index < queue.length) result.push(queue[index])
      }
    }
  }
  return result
}

export default class InterleavedProjectSequencer extends BaseSequencer {
  async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    // Vitest's default sort queues whole projects alphabetically. Start each
    // project's slow/failed files early while preserving its default ordering,
    // explicit group barriers, and the inherited shard selection.
    return interleaveTestProjects(await super.sort(files))
  }
}
