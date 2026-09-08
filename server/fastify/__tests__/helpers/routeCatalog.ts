interface ParsedRoute {
  method: string
  path: string
}

/**
 * Parse `app.printRoutes({ commonPrefix: false })` (an ASCII tree) into flat
 * (method, path) pairs. Deriving the route list from the live app — rather than
 * hard-coding it — is the point: a new route automatically enters this test.
 */
export function parseRouteTree(tree: string): ParsedRoute[] {
  const routes: ParsedRoute[] = []
  const stack: Array<{ depth: number; seg: string }> = []
  for (const line of tree.split('\n')) {
    if (!line.trim()) continue
    const match = line.match(/^([\s│]*)(?:├──|└──)?\s*(\S.*)$/)
    if (!match) continue
    const depth = Math.floor((match[1] ?? '').length / 4)
    let rest = match[2]
    let methods: string[] | null = null
    const withMethods = rest.match(/^(.*?)\s*\(([A-Z, ]+)\)\s*$/)
    let seg: string
    if (withMethods) {
      seg = withMethods[1]
      methods = withMethods[2].split(',').map((m) => m.trim())
    } else {
      seg = rest.trim()
    }
    while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop()
    const fullPath = stack.map((s) => s.seg).join('') + seg
    stack.push({ depth, seg })
    if (methods) {
      for (const method of methods) routes.push({ method, path: fullPath })
    }
  }
  return routes
}
