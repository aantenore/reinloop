import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

// Minimal JSON Schema (draft 2020-12) subset: exactly the keywords the agent-layers schemas use under test. A keyword
// outside the subset throws, so a schema change that needs more is noticed instead of silently not being checked.

type Schema = boolean | { [key: string]: unknown };
type Doc = { [key: string]: unknown };

const ANNOTATIONS = new Set(['$schema', '$id', 'title', 'description', 'examples', 'format', '$defs']);
const SUPPORTED = new Set([
  '$ref', 'type', 'required', 'properties', 'additionalProperties', 'propertyNames', 'items', 'enum', 'const',
  'anyOf', 'oneOf', 'pattern', 'minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems',
]);

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function typeOk(type: string, v: unknown): boolean {
  switch (type) {
    case 'object': return isObject(v);
    case 'array': return Array.isArray(v);
    case 'string': return typeof v === 'string';
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'integer': return Number.isInteger(v);
    case 'boolean': return typeof v === 'boolean';
    case 'null': return v === null;
    default: throw new Error(`schema-validate: unsupported type "${type}"`);
  }
}

const deepEqual = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export class SchemaSet {
  private readonly docs = new Map<string, Doc>();

  /** Loads schema files; a `$ref` to another file is resolved by file name among the loaded ones. */
  constructor(paths: string[]) {
    for (const p of paths) this.docs.set(basename(p), JSON.parse(readFileSync(p, 'utf8')) as Doc);
  }

  /** Errors of `data` against the root schema of `file`; an empty list means valid. */
  validate(file: string, data: unknown): string[] {
    const doc = this.docs.get(file);
    if (!doc) throw new Error(`schema-validate: schema file "${file}" not loaded`);
    const errors: string[] = [];
    this.check(doc, doc, data, '$', errors);
    return errors;
  }

  private resolve(ref: string, current: Doc): { schema: Schema; doc: Doc } {
    const [file, pointer = ''] = ref.split('#') as [string, string?];
    const doc = file === '' ? current : this.docs.get(basename(file));
    if (!doc) throw new Error(`schema-validate: $ref "${ref}" points to a file that is not loaded`);
    let node: unknown = doc;
    for (const raw of pointer.split('/').filter(Boolean)) {
      const key = raw.replaceAll('~1', '/').replaceAll('~0', '~');
      if (!isObject(node) || !(key in node)) throw new Error(`schema-validate: $ref "${ref}" does not resolve`);
      node = node[key];
    }
    return { schema: node as Schema, doc };
  }

  private check(schema: Schema, doc: Doc, v: unknown, at: string, errors: string[]): void {
    if (typeof schema === 'boolean') {
      if (!schema) errors.push(`${at}: schema is false`);
      return;
    }
    for (const key of Object.keys(schema)) {
      if (!SUPPORTED.has(key) && !ANNOTATIONS.has(key)) throw new Error(`schema-validate: unsupported keyword "${key}" at ${at}`);
    }
    if (typeof schema.$ref === 'string') {
      const target = this.resolve(schema.$ref, doc);
      this.check(target.schema, target.doc, v, at, errors);
    }
    if (schema.type !== undefined) {
      const types = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
      if (!types.some((t) => typeOk(t, v))) {
        errors.push(`${at}: expected ${types.join('|')}`);
        return;
      }
    }
    if (schema.const !== undefined && !deepEqual(schema.const, v)) errors.push(`${at}: expected const ${JSON.stringify(schema.const)}`);
    if (Array.isArray(schema.enum) && !schema.enum.some((e) => deepEqual(e, v))) errors.push(`${at}: not in enum ${JSON.stringify(schema.enum)}`);
    if (typeof v === 'string') {
      if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(v)) errors.push(`${at}: does not match ${schema.pattern}`);
      if (typeof schema.minLength === 'number' && v.length < schema.minLength) errors.push(`${at}: shorter than ${schema.minLength}`);
      if (typeof schema.maxLength === 'number' && v.length > schema.maxLength) errors.push(`${at}: longer than ${schema.maxLength}`);
    }
    if (typeof v === 'number') {
      if (typeof schema.minimum === 'number' && v < schema.minimum) errors.push(`${at}: below ${schema.minimum}`);
      if (typeof schema.maximum === 'number' && v > schema.maximum) errors.push(`${at}: above ${schema.maximum}`);
    }
    if (Array.isArray(v)) {
      if (typeof schema.minItems === 'number' && v.length < schema.minItems) errors.push(`${at}: fewer than ${schema.minItems} items`);
      if (typeof schema.maxItems === 'number' && v.length > schema.maxItems) errors.push(`${at}: more than ${schema.maxItems} items`);
      if (schema.items !== undefined) v.forEach((item, i) => this.check(schema.items as Schema, doc, item, `${at}[${i}]`, errors));
    }
    if (isObject(v)) {
      for (const name of (schema.required as string[] | undefined) ?? []) {
        if (!(name in v)) errors.push(`${at}: missing required "${name}"`);
      }
      const props = (schema.properties as Record<string, Schema> | undefined) ?? {};
      for (const [name, value] of Object.entries(v)) {
        if (name in props) this.check(props[name]!, doc, value, `${at}.${name}`, errors);
        else if (schema.additionalProperties === false) errors.push(`${at}: unexpected property "${name}"`);
        else if (schema.additionalProperties !== undefined) this.check(schema.additionalProperties as Schema, doc, value, `${at}.${name}`, errors);
        if (schema.propertyNames !== undefined) this.check(schema.propertyNames as Schema, doc, name, `${at}.<${name}>`, errors);
      }
    }
    for (const kw of ['anyOf', 'oneOf'] as const) {
      const branches = schema[kw] as Schema[] | undefined;
      if (!branches) continue;
      const matching = branches.filter((b) => {
        const sub: string[] = [];
        this.check(b, doc, v, at, sub);
        return sub.length === 0;
      }).length;
      if (kw === 'anyOf' ? matching === 0 : matching !== 1) errors.push(`${at}: ${kw} matched ${matching} branches`);
    }
  }
}
