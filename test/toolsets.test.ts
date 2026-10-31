import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';

import {buildTools, deniedBy, loadSpec, TOOLSETS as BUILD_TOOLSETS} from '../scripts/build-tools.mjs';
import {API_TOOLS} from '../src/generated/tools.js';
import {handleCall} from '../src/server.js';
import {parseToolsets, TOOLSETS} from '../src/toolsets.js';
import {connect, fakeApi, KEYS} from './helpers.js';

const denylist = JSON.parse(readFileSync(new URL('../denylist.json', import.meta.url), 'utf8'));
const specFile = new URL('../openapi/1platform-api.json', import.meta.url);

describe('toolsets por vertical', () => {
  it('la lista del generador y la del servidor son la misma', () => expect([...TOOLSETS]).toEqual(BUILD_TOOLSETS));
  it('toda tool tiene un toolset conocido y ningún toolset queda vacío', () => {
    for (const tool of API_TOOLS) expect(TOOLSETS).toContain(tool.toolset);
    for (const set of TOOLSETS) expect(API_TOOLS.some((t) => t.toolset === set)).toBe(true);
  });
  it('sin selección = todas; con selección suma siempre cuenta', () => {
    expect(parseToolsets(undefined)).toBeUndefined();
    expect(parseToolsets(' todos ')).toBeUndefined();
    expect([...parseToolsets('Pagos, envios')!].sort()).toEqual(['cuenta', 'envios', 'pagos']);
    expect(() => parseToolsets('pagos,nomina')).toThrow(/nomina/);
  });
  it('tools/list con un toolset lista sólo esa vertical más cuenta y la documentación', async () => {
    const {client} = await connect({fetch: fakeApi().fetch, credentials: KEYS, toolsets: parseToolsets('envios')});
    const names = (await client.listTools()).tools.map((t) => t.name);
    const expected = API_TOOLS.filter((t) => t.toolset === 'envios' || t.toolset === 'cuenta').map((t) => t.name);
    expect(names.sort()).toEqual(['api_get_operation', 'docs_get_page', 'docs_search', ...expected].sort());
  });
  it('llamar una tool de un toolset apagado no toca la red', async () => {
    const api = fakeApi();
    const r = await handleCall('listInvoices', {businessId: 'b1'}, {credentials: KEYS, apiBase: 'https://api-qa.1platform.pro/api/v1', fetch: api.fetch, broker: undefined as never, docs: undefined as never, toolsets: parseToolsets('envios')});
    expect(r.isError).toBe(true);
    expect(api.calls).toHaveLength(0);
  });
});

describe('denylist por método (retiros y dominios: se leen, no se escriben)', () => {
  it('GET bajo un prefijo de escritura se permite; POST se niega', () => {
    expect(deniedBy(denylist, 'getCashOutSummary', '/api/v1/users/cash-out/summary', 'GET')).toBeUndefined();
    expect(deniedBy(denylist, 'requestCashOutPayout', '/api/v1/users/cash-out/payouts', 'POST')).toMatch(/write under/);
    expect(deniedBy(denylist, 'registerDomain', '/api/v1/domains', 'POST')).toMatch(/write under/);
  });
  it('el manifiesto no puede sumar un retiro ni un registro de dominio', () => {
    for (const operationId of ['requestCashOutPayout', 'registerDomain', 'renewDomain']) {
      const {errors} = buildTools(loadSpec(specFile), {tools: [{operationId, readOnly: false, toolset: 'retiros'}]}, denylist);
      expect(errors.join()).toMatch(/denylist/);
    }
  });
  it('readOnly exige GET y el toolset tiene que existir', () => {
    expect(buildTools(loadSpec(specFile), {tools: [{operationId: 'stopAgentRun', readOnly: true, toolset: 'agentes'}]}, denylist).errors.join()).toMatch(/readOnly but POST/);
    expect(buildTools(loadSpec(specFile), {tools: [{operationId: 'listAgents', readOnly: true, toolset: 'nomina'}]}, denylist).errors.join()).toMatch(/toolset/);
  });
  it('ninguna escritura del manifiesto cobra, envía a terceros ni factura', () => {
    expect(API_TOOLS.filter((t) => !t.readOnly).map((t) => t.name).sort()).toEqual(['cancelPaymentLink', 'createPaymentLink', 'stopAgentRun', 'updateTelemetryIssue']);
  });
  it('el secreto de medición de la analítica se quita de la respuesta', () => {
    expect(API_TOOLS.find((t) => t.name === 'getAnalyticsStatus')!.redact).toEqual(['mp_secret_id', 'mp_secret_masked']);
  });
});
