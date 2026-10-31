import {describe, expect, it} from 'vitest';

import {connect, DOCS, fakeApi} from './helpers.js';

const llms = `# Docs\n\n- [Links de pago](${DOCS}/docs/saas/1platform-api/links-de-pago.md): Cree un enlace de cobro.\n- [Envíos](${DOCS}/docs/saas/1platform-api/envios.md): Registre y despache envíos.\n`;
const spec = {paths: {'/api/v1/x': {get: {operationId: 'getX', summary: 'X', responses: {200: {content: {'application/json': {schema: {$ref: '#/components/schemas/X'}}}}}}}}, components: {schemas: {X: {type: 'object', properties: {a: {type: 'string'}}}}}};

function docsApi() {
  return fakeApi((c) => {
    if (c.url === `${DOCS}/llms.txt`) return {status: 200, body: llms};
    if (c.url === `${DOCS}/docs/saas/1platform-api/envios.md`) return {status: 200, body: '# Envíos\n'};
    if (c.url === `${DOCS}/openapi/1platform-api.json`) return {status: 200, body: spec};
    return {status: 404, body: 'no'};
  });
}

describe('IPA-04 CA-1 docs tools work without keys', () => {
  it('docs_search ranks the index lines by the query, accents folded', async () => {
    const api = docsApi();
    const {client} = await connect({fetch: api.fetch});
    const r = (await client.callTool({name: 'docs_search', arguments: {query: 'envios'}})) as {content: Array<{text: string}>};
    expect(r.content[0]!.text).toContain('envios.md');
    expect(r.content[0]!.text).not.toContain('links-de-pago');
  });
  it('docs_get_page reads the .md of a docs path or URL, cached 10 minutes', async () => {
    const api = docsApi();
    const {client} = await connect({fetch: api.fetch});
    for (const path of ['/docs/saas/1platform-api/envios', `${DOCS}/docs/saas/1platform-api/envios.md`]) {
      const r = (await client.callTool({name: 'docs_get_page', arguments: {path}})) as {content: Array<{text: string}>};
      expect(r.content[0]!.text).toBe('# Envíos\n');
    }
    expect(api.count('/envios.md')).toBe(1);
  });
  it('docs_get_page refuses other hosts and non-page paths without fetching', async () => {
    const api = docsApi();
    const {client} = await connect({fetch: api.fetch});
    for (const path of ['https://evil.example/docs/x', '/api/v1/users/profile', '/docs/../../etc', 'file:///etc/passwd']) {
      const r = (await client.callTool({name: 'docs_get_page', arguments: {path}})) as {isError?: boolean};
      expect(r.isError).toBe(true);
    }
    expect(api.calls).toHaveLength(0);
  });
  it('api_get_operation returns the operation with refs resolved', async () => {
    const api = docsApi();
    const {client} = await connect({fetch: api.fetch});
    const r = (await client.callTool({name: 'api_get_operation', arguments: {operationId: 'getX'}})) as {content: Array<{text: string}>};
    expect(JSON.parse(r.content[0]!.text)).toMatchObject({method: 'GET', path: '/api/v1/x', responses: {200: {content: {'application/json': {schema: {properties: {a: {type: 'string'}}}}}}}});
    const missing = (await client.callTool({name: 'api_get_operation', arguments: {operationId: 'nope'}})) as {isError?: boolean};
    expect(missing.isError).toBe(true);
  });
});
