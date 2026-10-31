import {truncate} from '../http/api-client.js';

/**
 * The three tools that work without keys (IPA-04 CA-1). They read what the
 * portal publishes for agents — `/llms.txt`, `<page>.md` and the OpenAPI — and
 * keep it for 10 minutes. They only ever fetch from the docs origin, and only
 * paths shaped like a page: the model cannot point them at another host.
 */
export interface DocsDeps {
  docsBase: string;
  fetch: typeof fetch;
  now?: () => number;
}

const TTL_MS = 10 * 60_000;
const PAGE_PATH = /^\/(?:docs|prompts|skills)\/[A-Za-z0-9/_-]+$/;

export const DOCS_TOOLS = [
  {
    name: 'docs_search',
    description: 'Busca en la documentación de 1Platform para desarrolladores y devuelve las páginas más relevantes con su URL en Markdown. No necesita claves.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {type: 'string', minLength: 1, maxLength: 200, description: 'Qué busca, en palabras (por ejemplo: «crear un link de pago»).'},
        limit: {type: 'integer', minimum: 1, maximum: 25, default: 8},
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'docs_get_page',
    description: 'Devuelve una página de la documentación de 1Platform en Markdown. Acepta la ruta de la página (por ejemplo /docs/saas/1platform-api/links-de-pago) o su URL. No necesita claves.',
    inputSchema: {
      type: 'object',
      properties: {path: {type: 'string', minLength: 1, maxLength: 300, description: 'Ruta o URL de la página en developer.1platform.pro.'}},
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'api_get_operation',
    description: 'Devuelve el contrato exacto de una operación de la 1Platform API (método, ruta, parámetros, cuerpo, respuestas y códigos de error) a partir de su operationId. No necesita claves.',
    inputSchema: {
      type: 'object',
      properties: {operationId: {type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_]{0,99}$'}},
      required: ['operationId'],
      additionalProperties: false,
    },
  },
] as const;

export class DocsError extends Error {}

type Entry = {value: unknown; at: number};

export class Docs {
  private readonly cache = new Map<string, Entry>();
  private readonly now: () => number;

  constructor(private readonly deps: DocsDeps) {
    this.now = deps.now ?? Date.now;
  }

  private async get(path: string, as: 'text' | 'json'): Promise<unknown> {
    const hit = this.cache.get(path);
    if (hit && this.now() - hit.at < TTL_MS) return hit.value;
    let response: Response;
    try {
      response = await this.deps.fetch(`${this.deps.docsBase}${path}`, {signal: AbortSignal.timeout(15_000)});
    } catch {
      throw new DocsError('No se pudo contactar el portal de documentación.');
    }
    if (response.status === 404) throw new DocsError(`No existe ${path} en la documentación.`);
    if (!response.ok) throw new DocsError(`El portal de documentación respondió ${response.status}.`);
    const value = as === 'json' ? await response.json() : await response.text();
    if (this.cache.size > 200) this.cache.clear();
    this.cache.set(path, {value, at: this.now()});
    return value;
  }

  async search(query: string, limit = 8): Promise<string> {
    const index = String(await this.get('/llms.txt', 'text'));
    const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    const terms = fold(query).split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 2);
    const lines = index.split('\n').filter((line) => /^- \[[^\]]+\]\(https?:\/\/[^)]+\)/.test(line));
    const scored = lines
      .map((line) => ({line, score: terms.reduce((n, t) => n + (fold(line).includes(t) ? 1 : 0), 0)}))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    if (!scored.length) return `Sin resultados para «${query}». El índice completo está en ${this.deps.docsBase}/llms.txt.`;
    return scored.map((s) => s.line).join('\n');
  }

  async page(raw: string): Promise<string> {
    let path = raw.trim();
    if (/^https?:\/\//.test(path)) {
      const url = new URL(path);
      if (url.origin !== new URL(this.deps.docsBase).origin) throw new DocsError('Sólo se leen páginas de la documentación de 1Platform.');
      path = url.pathname;
    }
    path = path.replace(/\.md$/, '').replace(/\/$/, '').split('#')[0] ?? '';
    if (!PAGE_PATH.test(path) || path.includes('..')) throw new DocsError('La ruta no corresponde a una página de la documentación.');
    return truncate(String(await this.get(`${path}.md`, 'text'))).text;
  }

  async operation(operationId: string): Promise<string> {
    const spec = (await this.get('/openapi/1platform-api.json', 'json')) as {paths?: Record<string, Record<string, Record<string, unknown>>>; components?: {schemas?: Record<string, unknown>}};
    for (const [path, ops] of Object.entries(spec.paths ?? {})) {
      for (const [method, op] of Object.entries(ops)) {
        if (op?.operationId !== operationId) continue;
        const resolved = resolveRefs(spec, {method: method.toUpperCase(), path, ...op}, 6);
        return truncate(JSON.stringify(resolved, null, 2)).text;
      }
    }
    throw new DocsError(`No existe la operación ${operationId} en el OpenAPI de la 1Platform API.`);
  }
}

function resolveRefs(spec: {components?: {schemas?: Record<string, unknown>}}, node: unknown, depth: number, seen: string[] = []): unknown {
  if (Array.isArray(node)) return node.map((n) => resolveRefs(spec, n, depth, seen));
  if (!node || typeof node !== 'object') return node;
  const ref = (node as {$ref?: unknown}).$ref;
  if (typeof ref === 'string') {
    const name = ref.split('/').pop() ?? '';
    if (depth <= 0 || seen.includes(name)) return {$ref: ref};
    return resolveRefs(spec, spec.components?.schemas?.[name], depth - 1, [...seen, name]);
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) out[k] = resolveRefs(spec, v, depth, seen);
  return out;
}
