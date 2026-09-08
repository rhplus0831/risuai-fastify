import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import Ajv from 'ajv'
import standaloneCode from 'ajv/dist/standalone/index.js'
import { format, resolveConfig } from 'prettier'

export type JsonSchema = Record<string, unknown>
const roots = [
  'GenerationSettings',
  'FastifyDatabase',
  'DisplaySourceDatabase',
  'GenerationPreflightInputs',
  'ProviderGenerationSettings',
  'MemoryGenerationSettings',
] as const
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const generationInputSchemaPath = path.join(root, 'server/fastify/src/prompt/generationInputSchema.json')
export const generationInputValidatorsPath = path.join(root, 'server/fastify/src/prompt/generationInputValidators.js')
export const generationInputValidatorTypesPath = path.join(
  root,
  'server/fastify/src/prompt/generationInputValidators.d.ts',
)
export const generationInputValidationOptions = {
  allErrors: false,
  strict: false,
  strictNumbers: true,
  inlineRefs: false,
} as const
export const generationInputSchemaId = 'risu-generation-inputs-v1'
export const generationInputValidatorRoots = {
  validateGenerationSettings: 'GenerationSettings',
  validateFastifyDatabase: 'FastifyDatabase',
  validateDisplaySourceDatabase: 'DisplaySourceDatabase',
  validateGenerationPreflightInputs: 'GenerationPreflightInputs',
  validateProviderGenerationSettings: 'ProviderGenerationSettings',
  validateMemoryGenerationSettings: 'MemoryGenerationSettings',
} as const

/** Build-time only: emit the finite server contract; never load browser state. */
export function generateGenerationInputSchema(): JsonSchema {
  const configPath = path.join(root, 'server/fastify/tsconfig.json')
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath))
  const input = path.join(root, 'server/fastify/src/prompt/serverTypes.ts')
  const program = ts.createProgram([input], parsed.options)
  const checker = program.getTypeChecker()
  const source = program.getSourceFile(input)!
  const definitions: Record<string, JsonSchema> = {}
  const seen = new Map<ts.Type, string>()
  const sourceSymbols = checker.getExportsOfModule(checker.getSymbolAtLocation(source)!)

  function schema(type: ts.Type): JsonSchema {
    if (type.flags & ts.TypeFlags.Any)
      throw new Error(`Unrestricted any in generation contract: ${checker.typeToString(type)}`)
    if (type.flags & ts.TypeFlags.Unknown) return {}
    if (type.flags & ts.TypeFlags.Never) return { not: {} }
    if (type.flags & ts.TypeFlags.StringLiteral) return { const: (type as ts.StringLiteralType).value }
    if (type.flags & ts.TypeFlags.NumberLiteral) return { const: (type as ts.NumberLiteralType).value }
    if (type.flags & ts.TypeFlags.BooleanLiteral) return { const: checker.typeToString(type) === 'true' }
    if (type.flags & ts.TypeFlags.String) return { type: 'string' }
    if (type.flags & ts.TypeFlags.Number) return { type: 'number' }
    if (type.flags & ts.TypeFlags.Boolean) return { type: 'boolean' }
    if (type.flags & ts.TypeFlags.Null) return { type: 'null' }
    if (type.isUnion()) {
      const members = type.types.filter((member) => !(member.flags & ts.TypeFlags.Undefined))
      if (members.length === 1) return schema(members[0])
      return { anyOf: members.map(schema) }
    }
    if (checker.isTupleType(type)) {
      const arguments_ = checker.getTypeArguments(type as ts.TypeReference)
      return { type: 'array', items: arguments_.map(schema), minItems: arguments_.length, maxItems: arguments_.length }
    }
    if (checker.isArrayType(type))
      return { type: 'array', items: schema(checker.getTypeArguments(type as ts.TypeReference)[0]) }
    if (type.flags & ts.TypeFlags.Object || type.isIntersection()) {
      const existing = seen.get(type)
      if (existing) return { $ref: `#/$defs/${existing}` }
      const key = `record${seen.size}`
      seen.set(type, key)
      const properties: Record<string, JsonSchema> = {}
      const required: string[] = []
      const definition: JsonSchema = { type: 'object', properties }
      definitions[key] = definition
      for (const property of checker.getPropertiesOfType(type)) {
        const location = property.valueDeclaration ?? property.declarations?.[0] ?? source
        const propertyType = checker.getTypeOfSymbolAtLocation(property, location)
        properties[property.name] = schema(propertyType)
        if (!(property.flags & ts.SymbolFlags.Optional)) required.push(property.name)
      }
      if (required.length) definition.required = required
      const index = checker.getIndexTypeOfType(type, ts.IndexKind.String)
      if (index) definition.additionalProperties = schema(index)
      // JSON imports may carry future extension properties. They are retained as
      // data, but are deliberately absent from the consumer's finite TypeScript view.
      return { $ref: `#/$defs/${key}` }
    }
    throw new Error(`Unsupported generation contract: ${checker.typeToString(type)}`)
  }

  const entries: Record<string, JsonSchema> = {}
  for (const name of roots) {
    const symbol = sourceSymbols.find((candidate) => candidate.name === name)
    if (!symbol) throw new Error(`Missing generation contract ${name}`)
    entries[name] = schema(checker.getDeclaredTypeOfSymbol(symbol))
  }
  return { $schema: 'http://json-schema.org/draft-07/schema#', $defs: definitions, ...entries }
}

/** Emit validators from the same checked schema; production imports no compiler. */
export async function generateGenerationInputArtifacts() {
  const schema = generateGenerationInputSchema()
  const ajv = new Ajv({ ...generationInputValidationOptions, code: { source: true, esm: true } })
  ajv.addSchema({ $id: generationInputSchemaId, $defs: schema.$defs })
  const references: Record<string, string> = {}
  for (const [name, type] of Object.entries(generationInputValidatorRoots)) {
    const entry = schema[type]
    if (!entry || typeof entry !== 'object' || !('$ref' in entry) || typeof entry.$ref !== 'string') {
      throw new Error(`Invalid generated validator root ${type}`)
    }
    const id = `risu-generation-entry-${name}`
    ajv.addSchema({ $id: id, $ref: `${generationInputSchemaId}${entry.$ref}` })
    references[name] = id
  }
  const definitions = schema.$defs
  if (!definitions || typeof definitions !== 'object' || Array.isArray(definitions))
    throw new Error('Missing generated definitions')
  const metadata = {
    schemaDefinitions: Object.keys(definitions).length,
    roots: Object.keys(references).length,
    compiledAtBuildTime: true,
  }
  const banner = '// Generated by util/generation-input-schema.ts. Do not edit.\n'
  const validatorCode = standaloneCode(ajv, references)
  // Ajv emits deeply nested guard bodies. Preserve its generated function text;
  // formatting their indentation would inflate this static artifact manyfold.
  const javascriptAst = ts.createSourceFile(
    'validators.js',
    validatorCode,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  )
  const functionStarts = javascriptAst.statements
    .filter(ts.isFunctionDeclaration)
    .map((statement) => statement.getStart(javascriptAst))
  let annotatedCode = validatorCode
  for (const start of functionStarts.reverse())
    annotatedCode = annotatedCode.slice(0, start) + '\n// prettier-ignore\n' + annotatedCode.slice(start)
  const rawJavascript =
    banner +
    annotatedCode +
    `\nexport const generationInputValidatorMetadata = Object.freeze(${JSON.stringify(metadata)});\n`
  const declarations =
    banner +
    `import type {${roots.join(',')}} from './serverTypes.js';
export type GenerationInputValidator<T> = {
  (value:unknown):value is T;
  errors?:ReadonlyArray<{
    readonly instancePath:string;
    readonly schemaPath:string;
    readonly keyword:string;
    readonly params:Readonly<Record<string,unknown>>;
  }> | null;
};
${Object.entries(generationInputValidatorRoots)
  .map(([name, type]) => `export declare const ${name}:GenerationInputValidator<${type}>;`)
  .join('\n')}
export declare const generationInputValidatorMetadata: {
  readonly schemaDefinitions:${metadata.schemaDefinitions};
  readonly roots:${metadata.roots};
  readonly compiledAtBuildTime:true;
};
`
  const options = await resolveConfig(generationInputValidatorsPath)
  return {
    schema,
    javascript: await format(rawJavascript, { ...options, filepath: generationInputValidatorsPath }),
    declarations: await format(declarations, { ...options, filepath: generationInputValidatorTypesPath }),
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const artifacts = await generateGenerationInputArtifacts()
  fs.writeFileSync(generationInputSchemaPath, `${JSON.stringify(artifacts.schema, null, 2)}\n`)
  fs.writeFileSync(generationInputValidatorsPath, artifacts.javascript)
  fs.writeFileSync(generationInputValidatorTypesPath, artifacts.declarations)
}
