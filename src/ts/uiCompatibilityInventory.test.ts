import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import ts from 'typescript'
import { parseRoute } from './routerRoute'
import {
  phase4ControlInventory,
  phase4ResponsiveShellClassification,
  phase4RouteInventory,
} from './uiCompatibilityInventory'

const root = path.resolve('.')

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort()
}

function literalExpressionValues(expression: ts.Expression): string[] {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return [expression.text]
  if (ts.isParenthesizedExpression(expression)) return literalExpressionValues(expression.expression)
  if (ts.isConditionalExpression(expression)) {
    return [...literalExpressionValues(expression.whenTrue), ...literalExpressionValues(expression.whenFalse)]
  }
  return []
}

function controlAttributeValues(source: string, attribute: string): string[] {
  const values: string[] = []
  for (const match of source.matchAll(new RegExp(`${attribute}=(?:"([^"]+)"|\\{([^}]+)\\})`, 'gu'))) {
    if (match[1]) values.push(match[1])
    if (!match[2]) continue
    // Conditional markup can share one control while retaining distinct command
    // markers. Read its result branches, never unrelated literals in its test.
    const parsed = ts.createSourceFile('marker.ts', `const marker = ${match[2]}`, ts.ScriptTarget.Latest, true)
    const statement = parsed.statements[0]
    if (!statement || !ts.isVariableStatement(statement)) continue
    const expression = statement.declarationList.declarations[0]?.initializer
    if (expression) values.push(...literalExpressionValues(expression))
  }
  return sortedUnique(values)
}

function testIdValues(source: string): string[] {
  const values: string[] = []
  for (const match of source.matchAll(/data-testid=(?:"([^"]+)"|\{([^}]+)\})/gu)) {
    if (match[1]) values.push(match[1])
    if (match[2]) values.push(...[...match[2].matchAll(/'([^']+)'/gu)].map((literal) => literal[1]))
  }
  return sortedUnique(values)
}

function routeKindValues(source: string): string[] {
  const start = source.indexOf('export type AppRoute =')
  const end = source.indexOf('export interface StateRouteInput', start)
  expect(start, 'AppRoute declaration').toBeGreaterThanOrEqual(0)
  expect(end, 'StateRouteInput declaration').toBeGreaterThan(start)
  return sortedUnique([...source.slice(start, end).matchAll(/kind: '([^']+)'/gu)].map((match) => match[1]))
}

function mapKeys(source: string, declaration: string, nextDeclaration: string): string[] {
  const start = source.indexOf(`const ${declaration}`)
  const end = source.indexOf(`const ${nextDeclaration}`, start)
  expect(start, `${declaration} declaration`).toBeGreaterThanOrEqual(0)
  expect(end, `${nextDeclaration} declaration`).toBeGreaterThan(start)
  return sortedUnique([...source.slice(start, end).matchAll(/\['([^']+)',/gu)].map((match) => match[1]))
}

function productionFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      if (['__fixtures__', '__tests__', 'docs', 'testHarness', 'tests'].includes(entry.name)) return []
      return productionFiles(entryPath)
    }
    if (!/\.(?:svelte|ts)$/u.test(entry.name) || /(?:\.test\.|testStub)/u.test(entry.name)) return []
    return [entryPath]
  })
}

const semanticControlAttributes = [
  'data-risu-bookmark-action',
  'data-risu-chat-action',
  'data-risu-grid-action',
  'data-risu-message-action',
  'data-risu-mobile-character-action',
  'data-risu-responsive-shell',
  'data-risu-sidebar-tab',
  'data-risu-sidebar-toggle',
] as const

function markerName(attribute: (typeof semanticControlAttributes)[number]): string {
  return attribute.slice('data-risu-'.length)
}

function productionControlKeys(): string[] {
  const keys: string[] = []
  for (const file of productionFiles(path.join(root, 'src'))) {
    const source = fs.readFileSync(file, 'utf8')
    const relativeFile = path.relative(root, file)
    for (const attribute of semanticControlAttributes) {
      for (const value of controlAttributeValues(source, attribute)) {
        keys.push(`${relativeFile}\0${markerName(attribute)}:${value}`)
      }
    }
  }

  const testIdSources = sortedUnique(
    phase4ControlInventory
      .filter(({ controls }) => controls.some((control) => control.startsWith('testid:')))
      .map(({ source }) => source),
  )
  for (const relativeFile of testIdSources) {
    for (const value of testIdValues(read(relativeFile))) {
      keys.push(`${relativeFile}\0testid:${value}`)
    }
  }
  return sortedUnique(keys)
}

describe('Phase 4 UI compatibility inventory', () => {
  it('includes literal conditional control markers without treating condition values as controls', () => {
    expect(
      controlAttributeValues(
        `data-risu-grid-action={view === 'trash' ? 'delete-permanent' : (view === 'active' ? 'delete' : 'restore')}`,
        'data-risu-grid-action',
      ),
    ).toEqual(['delete', 'delete-permanent', 'restore'])
  })

  it('classifies every route family and registered settings/playground slug', () => {
    const routerSource = read('packages/shared-core/src/routerRoute.ts')
    const rootSegments = sortedUnique([...routerSource.matchAll(/parts\[0\] === '([^']+)'/gu)].map((match) => match[1]))

    expect(rootSegments).toEqual([...phase4RouteInventory.rootSegments])
    expect(routeKindValues(routerSource)).toEqual([...phase4RouteInventory.routeKinds].sort())
    expect(mapKeys(routerSource, 'settingIndexBySlug', 'settingSlugByIndex')).toEqual([
      ...phase4RouteInventory.settingsSections,
    ])
    expect(mapKeys(routerSource, 'playgroundIndexBySlug', 'playgroundSlugByIndex')).toEqual([
      ...phase4RouteInventory.playgroundTools,
    ])
    expect(sortedUnique(phase4RouteInventory.examples.map(({ kind }) => kind))).toEqual(
      [...phase4RouteInventory.routeKinds].sort(),
    )

    for (const routeCase of phase4RouteInventory.examples) {
      expect(parseRoute(routeCase.path).kind, routeCase.path).toBe(routeCase.kind)
    }
  })

  it('requires an explicit owner for every stable primary UI control marker', () => {
    const classifiedControls = phase4ControlInventory.flatMap(({ controls, source }) =>
      controls.map((control) => `${source}\0${control}`),
    )

    expect(sortedUnique(classifiedControls)).toEqual(productionControlKeys())
    expect(classifiedControls).toHaveLength(new Set(classifiedControls).size)
    expect(phase4ControlInventory.every(({ owner, source }) => owner.length > 0 && source.length > 0)).toBe(true)
  })

  it('classifies the live MobileCharacters controls by their current owners', () => {
    const mobileControls = phase4ControlInventory.filter(
      ({ source }) => source === 'src/lib/Mobile/MobileCharacters.svelte',
    )

    expect(mobileControls).toEqual([
      {
        source: 'src/lib/Mobile/MobileCharacters.svelte',
        owner: 'route-state',
        controls: ['mobile-character-action:open'],
      },
      {
        source: 'src/lib/Mobile/MobileCharacters.svelte',
        owner: 'character-command',
        controls: ['mobile-character-action:create'],
      },
    ])
    expect(read('src/lib/Others/GridCatalog.svelte')).toContain('<MobileCharacters')
  })

  it('pins the signed shared responsive shell in place of the unmounted baseline mobile shell', () => {
    const appSource = read('src/App.svelte')
    const workspaceSource = read('src/lib/Workspace.svelte')
    const shellSource = read('src/lib/ConversationShell.svelte')
    const storesSource = read('src/ts/stores.svelte.ts')
    const legacyImports = productionFiles(path.join(root, 'src')).filter((file) => {
      if (phase4ResponsiveShellClassification.baselineShell.some((component) => file.endsWith(`${component}.svelte`))) {
        return false
      }
      const source = fs.readFileSync(file, 'utf8')
      return phase4ResponsiveShellClassification.baselineShell.some((component) =>
        source.includes(`/Mobile/${component}.svelte`),
      )
    })
    const betaMobileGuiOwners = productionFiles(path.join(root, 'src'))
      .filter((file) => !file.endsWith('uiCompatibilityInventory.ts'))
      .filter((file) => fs.readFileSync(file, 'utf8').includes(phase4ResponsiveShellClassification.baselineControl))

    expect(phase4ResponsiveShellClassification).toMatchObject({
      sourceObligation: 'fork-parity',
      disposition: 'signed-divergence',
      signedDecisionId: 'ORC-DECISION-060',
    })
    expect(legacyImports).toEqual([])
    expect(betaMobileGuiOwners).toEqual([])
    expect(storesSource).toContain(`DynamicGUI.set(${phase4ResponsiveShellClassification.currentBreakpoint})`)
    expect(appSource).toContain('<Workspace')
    expect(appSource).toContain('writerNavigationOpen={writerNavigationVisible && $sideBarStore}')
    expect(workspaceSource).toContain('<ConversationShell')
    expect(workspaceSource).toContain('responsive={$DynamicGUI}')
    expect(workspaceSource).toContain(
      'navigationOpen={readerMode ? !$DynamicGUI || readerNavigationOpen : writerNavigationOpen}',
    )
    expect(shellSource).toContain('{:else if responsive && (navigationOpen || preserveResponsiveNavigation)}')
    expect(shellSource).toContain(`data-risu-responsive-shell="${phase4ResponsiveShellClassification.currentShell}"`)
    expect(shellSource).toContain('use:conditionalModalFocusTrap={navigationOpen}')
    expect(shellSource).toContain('modalFocusTrap(node)')
    expect(appSource).toContain('<Sidebar')
    expect(appSource).toContain('<ChatScreen')
    for (const component of phase4ResponsiveShellClassification.baselineShell) {
      expect(appSource).not.toContain(component)
    }
  })
})
