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
  it('las escrituras del manifiesto son exactamente las revisadas (ninguna cobra en el acto, factura ni mueve dinero)', () => {
    expect(API_TOOLS.filter((t) => !t.readOnly).map((t) => t.name).sort()).toEqual([
      'archiveSubscriptionPlan', 'assignTask', 'bookAppointment', 'cancelAppointment', 'cancelMerchantSubscription',
      'cancelPaymentLink', 'cancelSocialPost', 'cancelTerminalCharge', 'cancelTerminalRequest', 'completeAppointment', 'createBookingLink',
      'createCustomer', 'createMyIntakeLink', 'createPaymentLink', 'createSocialPost', 'createSubscriptionInvitation',
      'createSubscriptionPlan', 'createSubtask', 'createTask', 'createTerminalCharge', 'createTerminalRequest', 'publishSubscriptionPlan',
      'reassignAppointment', 'rescheduleAppointment', 'rescheduleSocialPost', 'stopAgentRun', 'submitSocialPost',
      'updateCustomer', 'updateSocialPost', 'updateSubscriptionPlan', 'updateSubtaskStatus', 'updateTask',
      'updateTelemetryIssue', 'updateTerminalRequest',
    ]);
  });
  it('los enlaces de agenda no pueden revocar el enlace vigente (rotate fuera del esquema)', () => {
    for (const name of ['createBookingLink', 'createMyIntakeLink']) {
      const tool = API_TOOLS.find((t) => t.name === name)!;
      expect(tool.omit).toEqual(['rotate']);
      expect(Object.keys(tool.inputSchema.properties)).not.toContain('rotate');
      expect(tool.bodyParams).not.toContain('rotate');
    }
  });
  it('quedan fuera publicar ya, pagar, encargar piezas, enviar la solicitud de terminal, aprobar y borrar', () => {
    const names = new Set(API_TOOLS.map((t) => t.name));
    for (const excluded of ['publishSocialPostNow', 'approveSocialPost', 'replySocialComment', 'resolveSocialTarget', 'reassignSocialTargetPayer',
      'deleteSocialPost', 'createStudioOrder', 'payStudioDebt', 'createStudioPresenter', 'deleteStudioPresenter', 'submitTerminalRequest',
      'deleteTask', 'deleteTaskAttachment', 'quoteCashOutPayout', 'requestCashOutPayout']) {
      expect(names.has(excluded)).toBe(false);
    }
  });
  it('el secreto de medición de la analítica se quita de la respuesta', () => {
    expect(API_TOOLS.find((t) => t.name === 'getAnalyticsStatus')!.redact).toEqual(['mp_secret_id', 'mp_secret_masked']);
  });
});

describe('cobros remotos a terminal (épica cobros-remotos-a-terminal, D-9)', () => {
  const tool = (name: string) => API_TOOLS.find((t) => t.name === name)!;

  it('el toolset terminal suma las cinco operaciones; crear y cancelar escriben', () => {
    const terminal = API_TOOLS.filter((t) => t.toolset === 'terminal').map((t) => t.name);
    for (const name of ['listBusinessTerminals', 'createTerminalCharge', 'getTerminalCharge', 'listTerminalCharges', 'cancelTerminalCharge']) expect(terminal).toContain(name);
    expect(tool('createTerminalCharge').readOnly).toBe(false);
    expect(tool('cancelTerminalCharge').readOnly).toBe(false);
    for (const name of ['listBusinessTerminals', 'getTerminalCharge', 'listTerminalCharges']) expect(tool(name).readOnly).toBe(true);
  });

  it('idempotency_key viaja en el cuerpo y es obligatoria (el build quita las cabeceras)', () => {
    const create = tool('createTerminalCharge');
    expect(create.bodyParams).toContain('idempotency_key');
    expect(create.inputSchema.required).toEqual(expect.arrayContaining(['business_id', 'terminal_id', 'amount', 'reference', 'idempotency_key']));
    expect((create.inputSchema.properties.amount as {type: string}).type).toBe('string');
  });

  it('crear advierte la excepción, la clave nueva tras un rechazo, el timeout que puede aprobarse y el doble cobro', () => {
    const d = tool('createTerminalCharge').description;
    expect(d).toContain('confirme con la persona');
    expect(d).toContain('acerque su tarjeta');
    expect(d).toContain('clave NUEVA');
    expect(d).toContain('timeout todavía puede aprobarse');
    expect(d).toContain('reference_conflict');
    expect(d).toContain('No confirmado: revise el pago');
  });

  it('consultar y listar describen unreconciled como «No confirmado»', () => {
    for (const name of ['getTerminalCharge', 'listTerminalCharges']) expect(tool(name).description).toContain('unreconciled (No confirmado: revise el pago');
  });

  it('las rutas con {business_id} también piden listBusinessesForUser', () => {
    expect(tool('createTerminalCharge').description).toContain('Obtenga el business_id con listBusinessesForUser');
  });

  it('el POST manda idempotency_key en el cuerpo, nunca como cabecera', async () => {
    const api = fakeApi();
    const {client} = await connect({fetch: api.fetch, credentials: KEYS});
    await client.callTool({name: 'createTerminalCharge', arguments: {business_id: 'b1', terminal_id: 388, amount: '125.50', reference: '8841', idempotency_key: 'pedido-8841-v1'}});
    const post = api.calls.find((c) => c.url.endsWith('/businesses/b1/terminal-charges'))!;
    expect(post.method).toBe('POST');
    expect(JSON.parse(post.body!)).toEqual({terminal_id: 388, amount: '125.50', reference: '8841', idempotency_key: 'pedido-8841-v1'});
    expect(Object.keys(post.headers)).not.toContain('idempotency-key');
  });

  it('la excepción no abre la denylist: cobrar saldo, recargas, reembolsos y retiros siguen negados', () => {
    for (const operationId of ['createPaymentTransaction', 'createBalanceTopup', 'refundPaymentTransaction']) expect(denylist.operationIds).toContain(operationId);
    expect(deniedBy(denylist, 'x', '/api/v1/users/balance/topups', 'POST')).toMatch(/path prefix/);
    expect(deniedBy(denylist, 'requestCashOutPayout', '/api/v1/users/cash-out/payouts', 'POST')).toMatch(/write under/);
    expect(denylist.$comment).toContain('createTerminalCharge');
  });

  it('notes mal formadas rompen el build (control)', () => {
    const bad = {tools: [{operationId: 'getTerminalCharge', readOnly: true, toolset: 'terminal', notes: 'texto suelto'}]};
    expect(buildTools(loadSpec(specFile), bad, denylist).errors.join()).toMatch(/notes must be a list/);
  });
});
