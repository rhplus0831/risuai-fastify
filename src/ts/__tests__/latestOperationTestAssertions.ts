import { expect } from 'vitest'

export function expectNewerOperationWins<Operation, Result>(input: {
  begin: () => Operation
  complete: (operation: Operation, attempt: 'newer' | 'older') => Result | null
  expectedNewer: Result
  clear: (operation: Operation) => void
}): void {
  const older = input.begin()
  const newer = input.begin()

  try {
    expect(input.complete(newer, 'newer')).toEqual(input.expectedNewer)
    expect(input.complete(older, 'older')).toBeNull()
  } finally {
    input.clear(older)
    input.clear(newer)
  }
}

export function expectCanceledPickerKeepsOperationCurrent<Operation, Result>(input: {
  begin: () => Operation
  captureCanceledTarget: () => unknown
  complete: (operation: Operation) => Result | null
  expected: Result
  clear: (operation: Operation) => void
}): void {
  const operation = input.begin()

  try {
    expect(input.captureCanceledTarget()).not.toBeNull()
    expect(input.complete(operation)).toEqual(input.expected)
  } finally {
    input.clear(operation)
  }
}
