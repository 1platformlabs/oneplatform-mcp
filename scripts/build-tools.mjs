#!/usr/bin/env node
/**
 * Generates src/generated/tools.ts from the OpenAPI and tools.manifest.json (D-9).
 *
 * Per tool:
 *  - every `in: header` parameter is DROPPED from the input schema — the server
 *    injects Authorization and x-user-token itself, and a model must never be
 *    able to pass somebody else's token (nor an Idempotency-Key);
 *  - path, query and JSON-body fields are flattened into one object (a name
 *    collision is an error, not a silent overwrite);
 *  - `$ref`s are inlined;
 *  - `omit` fields leave the schema;
 *  - list operations get `limit` defaulting to 20.
 *
 * It also enforces the two invariants an allowlist exists for: the manifest is a
 * subset of the spec, and it does not intersect the denylist. And it fails if a
 * 2xx response schema exposes a key that looks sensitive and is neither redacted
 * nor reviewed (T-22).
 *
 *   node scripts/build-tools.mjs          # write src/generated/tools.ts
 *   node scripts/build-tools.mjs --check  # fail if the committed file differs
 */
import {readFileSync, writeFileSync, existsSync} from 'node:fs';

const ROOT = new URL('../', import.meta.url);
const SPEC_FILE = new URL('openapi/1platform-api.json', ROOT);
const OUT = new URL('src/generated/tools.ts', ROOT);
const SENSITIVE = /token|secret|password|api_key|authorization|headers/i;
const DROP_KEYS = new Set(['example', 'examples', 'title']);

export function loadSpec(file = SPEC_FILE) {
  if (!existsSync(file)) throw new Error('openapi/1platform-api.json is missing: run `npm run fetch-openapi`');
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function indexOperations(spec) {
  const byId = new Map();
  for (const [path, ops] of Object.entries(spec.paths ?? {})) {
    for (const [method, op] of Object.entries(ops)) {
      if (op && typeof op === 'object' && op.operationId) byId.set(op.operationId, {method: method.toUpperCase(), path, op});
    }
  }
  return byId;
}

function deref(spec, node, seen = []) {
  if (Array.isArray(node)) return node.map((item) => deref(spec, item, seen));
  if (!node || typeof node !== 'object') return node;
  if (node.$ref) {
    const name = node.$ref.split('/').pop();
    if (seen.includes(name)) return {type: 'object', description: `(${name}, recursive)`};
    const target = spec.components?.schemas?.[name];
    if (!target) throw new Error(`unresolved $ref ${node.$ref}`);
    return deref(spec, target, [...seen, name]);
  }
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (DROP_KEYS.has(key) || key.startsWith('x-')) continue;
    out[key] = deref(spec, value, seen);
  }
  return out;
}

export function sensitiveKeys(schema, out = new Set()) {
  if (!schema || typeof schema !== 'object') return out;
  for (const [key, value] of Object.entries(schema.properties ?? {})) {
    if (SENSITIVE.test(key)) out.add(key);
    sensitiveKeys(value, out);
  }
  for (const key of ['items', 'additionalProperties']) if (schema[key] && typeof schema[key] === 'object') sensitiveKeys(schema[key], out);
  for (const key of ['anyOf', 'oneOf', 'allOf']) for (const part of schema[key] ?? []) sensitiveKeys(part, out);
  return out;
}

export const TOOLSETS = ['cuenta', 'pagos', 'retiros', 'suscripciones', 'terminal', 'facturacion', 'envios', 'sitios', 'analitica', 'correo', 'dominios', 'telemetria', 'ventas', 'agentes'];

const under = (path, prefix) => path === prefix || path.startsWith(`${prefix}/`);

export function deniedBy(denylist, operationId, path, method = 'GET') {
  if (denylist.operationIds.includes(operationId)) return `operationId ${operationId}`;
  const prefix = denylist.pathPrefixes.find((p) => under(path, p));
  if (prefix) return `path prefix ${prefix}`;
  const writePrefix = method !== 'GET' ? (denylist.writePathPrefixes ?? []).find((p) => under(path, p)) : undefined;
  return writePrefix ? `write under ${writePrefix}` : undefined;
}

export function buildTools(spec, manifest, denylist) {
  const ops = indexOperations(spec);
  const errors = [];
  const tools = [];
  for (const entry of manifest.tools) {
    const found = ops.get(entry.operationId);
    if (!found) { errors.push(`${entry.operationId}: not in the OpenAPI`); continue; }
    const denied = deniedBy(denylist, entry.operationId, found.path, found.method);
    if (denied) { errors.push(`${entry.operationId}: in the denylist (${denied})`); continue; }
    if (entry.readOnly === true && found.method !== 'GET') { errors.push(`${entry.operationId}: readOnly but ${found.method}`); continue; }
    if (!TOOLSETS.includes(entry.toolset)) { errors.push(`${entry.operationId}: toolset "${entry.toolset}" is not one of ${TOOLSETS.join(', ')}`); continue; }
    const omit = entry.omit ?? [];
    const redact = entry.redact ?? [];
    const properties = {};
    const required = new Set();
    const pathParams = [];
    const queryParams = [];
    const pathPatterns = {};
    const add = (name, schema, isRequired, where) => {
      if (properties[name]) { errors.push(`${entry.operationId}: "${name}" collides between ${where} and another location`); return; }
      if (omit.includes(name)) return;
      properties[name] = schema;
      if (isRequired) required.add(name);
    };
    for (const param of deref(spec, found.op.parameters ?? [])) {
      if (param.in === 'header' || param.in === 'cookie') continue;
      const schema = {...(param.schema ?? {type: 'string'})};
      if (param.description) schema.description = param.description;
      if (param.in === 'path') {
        pathParams.push(param.name);
        if (schema.pattern) pathPatterns[param.name] = schema.pattern;
      } else if (param.in === 'query') {
        queryParams.push(param.name);
        if (param.name === 'limit') schema.default = 20;
      }
      add(param.name, schema, param.required === true || param.in === 'path', param.in);
    }
    const bodyParams = [];
    const bodySchema = deref(spec, found.op.requestBody?.content?.['application/json']?.schema);
    if (bodySchema) {
      for (const [name, schema] of Object.entries(bodySchema.properties ?? {})) {
        if (!omit.includes(name)) bodyParams.push(name);
        add(name, schema, (bodySchema.required ?? []).includes(name), 'body');
      }
    }
    for (const name of omit) {
      if (!bodySchema?.properties?.[name] && !queryParams.includes(name)) errors.push(`${entry.operationId}: omit "${name}" is not a field of the operation`);
    }
    const reviewed = Object.keys(denylist.reviewedResponseKeys ?? {}).filter((k) => !k.startsWith('$'));
    for (const [code, response] of Object.entries(found.op.responses ?? {})) {
      if (!code.startsWith('2')) continue;
      const schema = deref(spec, response)?.content?.['application/json']?.schema;
      for (const key of sensitiveKeys(schema)) {
        if (!redact.includes(key) && !reviewed.includes(key)) errors.push(`${entry.operationId}: response key "${key}" looks sensitive; add it to redact[] or to reviewedResponseKeys`);
      }
    }
    const summary = String(found.op.summary ?? entry.operationId).trim();
    const detail = String(found.op.description ?? '').trim().split('\n\n')[0].slice(0, 600);
    const notes = [];
    if (found.path.includes('{businessId}')) notes.push('Obtenga el businessId con listBusinessesForUser antes de llamar a esta herramienta.');
    notes.push('Un 403 con module_disabled indica un módulo apagado en el espacio de trabajo, no una falla del servidor MCP.');
    if (!entry.readOnly) notes.push('Escribe en la cuenta: confirme con la persona antes de ejecutarla.');
    tools.push({
      name: entry.operationId,
      method: found.method,
      path: found.path,
      readOnly: entry.readOnly === true,
      toolset: entry.toolset,
      omit,
      redact,
      pathParams,
      queryParams,
      bodyParams,
      pathPatterns,
      description: [summary, detail, ...notes].filter(Boolean).join('\n\n'),
      inputSchema: {type: 'object', properties, required: [...required], additionalProperties: false},
    });
  }
  return {tools, errors};
}

export function render(tools) {
  return `// GENERATED by scripts/build-tools.mjs from the OnePlatform OpenAPI and tools.manifest.json.
// Do not edit by hand: change the manifest and run \`npm run build-tools\`.
export interface ApiTool {
  name: string;
  method: string;
  path: string;
  readOnly: boolean;
  toolset: string;
  omit: string[];
  redact: string[];
  pathParams: string[];
  queryParams: string[];
  bodyParams: string[];
  pathPatterns: Record<string, string>;
  description: string;
  inputSchema: {type: 'object'; properties: Record<string, unknown>; required: string[]; additionalProperties: false};
}

export const API_TOOLS: ApiTool[] = ${JSON.stringify(tools, null, 2)};
`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const manifest = JSON.parse(readFileSync(new URL('tools.manifest.json', ROOT), 'utf8'));
  const denylist = JSON.parse(readFileSync(new URL('denylist.json', ROOT), 'utf8'));
  const {tools, errors} = buildTools(loadSpec(), manifest, denylist);
  if (errors.length) {
    for (const error of errors) console.error(error);
    process.exit(1);
  }
  const text = render(tools);
  if (process.argv.includes('--check')) {
    const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
    if (current !== text) {
      console.error('src/generated/tools.ts is stale against the OpenAPI: run `npm run fetch-openapi && npm run build-tools` and commit it');
      process.exit(1);
    }
    console.log(`build-tools --check: ${tools.length} tools up to date`);
  } else {
    writeFileSync(OUT, text);
    console.log(`build-tools: ${tools.length} tools written`);
  }
}
