import { describe, expect, it } from 'vitest'
import { interleaveTestProjects } from './vitest.sequencer'

function file(name: string, projectName: string, groupOrder = 0) {
  return { name, project: { name: projectName, config: { sequence: { groupOrder } } } }
}

describe('frontend project scheduling', () => {
  it('starts every project before draining a larger project, preserving each project order', () => {
    const dom = [file('failed', 'dom'), file('slow', 'dom'), file('fast', 'dom')]
    const node = [file('slow-cli', 'node'), file('fast-cli', 'node')]
    const svelteNode = [file('runes', 'svelte-node')]
    const input = [...dom, ...node, ...svelteNode]

    const result = interleaveTestProjects(input)

    expect(result).toEqual([dom[0], node[0], svelteNode[0], dom[1], node[1], dom[2]])
    expect(new Set(result)).toEqual(new Set(input))
    expect(input).toEqual([...dom, ...node, ...svelteNode])
  })

  it('keeps explicit execution groups separate even when project names repeat', () => {
    const first = [file('first-a', 'dom', 1), file('first-b', 'dom', 1), file('first-c', 'node', 1)]
    const second = [file('second-a', 'dom', 2), file('second-b', 'node', 2)]

    expect(interleaveTestProjects([...first, ...second])).toEqual([first[0], first[2], first[1], ...second])
  })

  it('handles an empty selection and retains single-project sequencing', () => {
    expect(interleaveTestProjects([])).toEqual([])
    const files = [file('failed', 'node'), file('slow', 'node'), file('fast', 'node')]
    expect(interleaveTestProjects(files)).toEqual(files)
  })
})
