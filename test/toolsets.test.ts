import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';

import {buildTools, deniedBy, loadSpec, TOOLSETS as BUILD_TOOLSETS} from '../scripts/build-tools.mjs';
import {API_TOOLS} from '../src/generated/tools.js';
import {handleCall} from '../src/server.js';
import {LEGACY_TOOLSET_ALIASES, parseToolsets, TOOLSETS} from '../src/toolsets.js';
import {connect, fakeApi, KEYS} from './helpers.js';

const denylist = JSON.parse(readFileSync(new URL('../denylist.json', import.meta.url), 'utf8'));
const specFile = new URL('../openapi/1platform-api.json', import.meta.url);

describe('toolsets por vertical', () => {
  it('la lista del generador y la del servidor son la misma', () => expect([...TOOLSETS]).toEqual(BUILD_TOOLSETS));
  it('toda tool tiene un toolset conocido y ningún toolset queda vacío', () => {
    for (const tool of API_TOOLS) expect(TOOLSETS).toContain(tool.toolset);
    for (const set of TOOLSETS) expect(API_TOOLS.some((t) => t.toolset === set)).toBe(true);
  });
  it('sin selección = todas; con selección suma siempre account', () => {
    expect(parseToolsets(undefined)).toBeUndefined();
    expect(parseToolsets(' all ')).toBeUndefined();
    expect(parseToolsets(' todos ')).toBeUndefined();
    expect([...parseToolsets('Payments, shipping')!].sort()).toEqual(['account', 'payments', 'shipping']);
    expect(() => parseToolsets('payments,payroll')).toThrow(/payroll/);
  });
  it('los nombres en español de 0.3.0 siguen funcionando como alias', () => {
    expect([...parseToolsets('Pagos, envios')!].sort()).toEqual(['account', 'payments', 'shipping']);
    expect([...parseToolsets('cuenta,cupones,payments')!].sort()).toEqual(['account', 'coupons', 'payments']);
    for (const [alias, name] of Object.entries(LEGACY_TOOLSET_ALIASES)) {
      expect(TOOLSETS).toContain(name);
      expect(TOOLSETS as readonly string[]).not.toContain(alias);
    }
    expect(() => parseToolsets('pagos,nomina')).toThrow(/nomina/);
  });
  it('tools/list con un toolset lista sólo esa vertical más account y la documentación', async () => {
    const {client} = await connect({fetch: fakeApi().fetch, credentials: KEYS, toolsets: parseToolsets('shipping')});
    const names = (await client.listTools()).tools.map((t) => t.name);
    const expected = API_TOOLS.filter((t) => t.toolset === 'shipping' || t.toolset === 'account').map((t) => t.name);
    expect(names.sort()).toEqual(['api_get_operation', 'docs_get_page', 'docs_search', ...expected].sort());
  });
  it('llamar una tool de un toolset apagado no toca la red', async () => {
    const api = fakeApi();
    const r = await handleCall('listInvoices', {businessId: 'b1'}, {credentials: KEYS, apiBase: 'https://api-qa.1platform.pro/api/v1', fetch: api.fetch, broker: undefined as never, docs: undefined as never, toolsets: parseToolsets('shipping')});
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
      const {errors} = buildTools(loadSpec(specFile), {tools: [{operationId, readOnly: false, toolset: 'payouts'}]}, denylist);
      expect(errors.join()).toMatch(/denylist/);
    }
  });
  it('readOnly exige GET y el toolset tiene que existir', () => {
    expect(buildTools(loadSpec(specFile), {tools: [{operationId: 'stopAgentRun', readOnly: true, toolset: 'agentes'}]}, denylist).errors.join()).toMatch(/readOnly but POST/);
    expect(buildTools(loadSpec(specFile), {tools: [{operationId: 'listAgents', readOnly: true, toolset: 'nomina'}]}, denylist).errors.join()).toMatch(/toolset/);
  });
  it('las escrituras del manifiesto son exactamente las revisadas (ninguna factura ni mueve dinero; la única que cobra en el acto es searchKnowledge, con su precio en la descripción)', () => {
    expect(API_TOOLS.filter((t) => !t.readOnly).map((t) => t.name).sort()).toEqual([
      'archiveSubscriptionPlan', 'assignTask', 'bookAppointment', 'cancelAppointment', 'cancelMerchantSubscription',
      'cancelPaymentLink', 'cancelSocialPost', 'cancelTerminalRequest', 'completeAppointment', 'createBookingLink',
      'createCoupon', 'createCustomer', 'createMyIntakeLink', 'createPaymentLink', 'createProspectingProspect', 'createSocialPost', 'createSubscriptionInvitation',
      'createSubscriptionPlan', 'createSubtask', 'createTask', 'createTerminalRequest', 'importProspectingProspects', 'publishSubscriptionPlan',
      'reassignAppointment', 'rescheduleAppointment', 'rescheduleSocialPost', 'searchKnowledge', 'stopAgentRun', 'submitSocialPost',
      'updateCoupon', 'updateCustomer', 'updateSocialPost', 'updateSubscriptionPlan', 'updateSubtaskStatus', 'updateTask',
      'updateTelemetryIssue', 'updateTerminalRequest',
    ]);
  });
  it('cupones: las rutas de máquina, el canje de saldo y el protocolo de canje están en la denylist', () => {
    expect(deniedBy(denylist, 'redeemBalanceCoupon', '/api/v1/users/coupons/redeem', 'POST')).toMatch(/path prefix/);
    expect(deniedBy(denylist, 'reserveStoreCoupon', '/api/v1/integrations/coupons/stores/{slug}/redemptions', 'POST')).toMatch(/path prefix/);
    expect(deniedBy(denylist, 'reserveCoupon', '/api/v1/coupons/redemptions', 'POST')).toMatch(/path prefix/);
    expect(deniedBy(denylist, 'confirmCouponRedemption', '/api/v1/coupons/redemptions/{redemption_id}/confirm', 'POST')).toMatch(/path prefix/);
    expect(deniedBy(denylist, 'createPlatformCoupon', '/api/v1/platform/coupons', 'POST')).toMatch(/path prefix/);
    expect(deniedBy(denylist, 'createCouponBatch', '/api/v1/coupons/batches', 'POST')).toMatch(/operationId/);
    expect(deniedBy(denylist, 'listCoupons', '/api/v1/coupons', 'GET')).toBeUndefined();
  });
  it('cupones: ni charge_fee ni cabeceras llegan al modelo', () => {
    for (const t of API_TOOLS.filter((x) => x.toolset === 'coupons')) expect(Object.keys(t.inputSchema.properties)).not.toContain('charge_fee');
    expect(API_TOOLS.filter((x) => x.toolset === 'coupons').map((x) => x.name).sort()).toEqual(['createCoupon', 'exportCouponBatch', 'getCoupon', 'getMyStoreCoupon', 'listCoupons', 'listMyCouponStores', 'listMyStoreCoupons', 'updateCoupon']);
  });
  it('base de conocimiento: se listan fuentes, uso y sincronización y se prueba una búsqueda; subir, reindexar, borrar y cambiar la sincronización quedan fuera', () => {
    expect(API_TOOLS.filter((x) => x.path.startsWith('/api/v1/knowledge/')).map((x) => x.name).sort()).toEqual(['getKnowledgeSync', 'getKnowledgeUsage', 'listKnowledgeSources', 'searchKnowledge']);
    for (const operationId of ['createKnowledgeSource', 'reindexKnowledgeSource', 'deleteKnowledgeSource', 'updateKnowledgeSync']) {
      expect(denylist.operationIds).toContain(operationId);
      expect(denylist.$comment).toContain(operationId);
    }
    const {errors} = buildTools(loadSpec(specFile), {tools: [{operationId: 'createKnowledgeSource', readOnly: false, toolset: 'agents'}]}, denylist);
    expect(errors.join()).toMatch(/createKnowledgeSource: in the denylist/);
  });
  it('searchKnowledge cobra por llamada: pide confirmación y su descripción dice el precio', () => {
    const tool = API_TOOLS.find((t) => t.name === 'searchKnowledge')!;
    expect(tool.readOnly).toBe(false);
    expect(tool.toolset).toBe('agents');
    expect(tool.description).toMatch(/US\$0\.02/);
    expect(tool.description).toMatch(/getBalanceHistory/);
  });
  it('note del manifiesto: se suma a la descripción y tiene que ser texto no vacío', () => {
    const spec = loadSpec(specFile);
    const ok = buildTools(spec, {tools: [{operationId: 'listAgents', readOnly: true, toolset: 'agents', note: 'Nota de prueba.'}]}, denylist);
    expect(ok.errors).toEqual([]);
    expect(ok.tools[0].description).toContain('Nota de prueba.');
    for (const note of ['', '   ', 3]) {
      expect(buildTools(spec, {tools: [{operationId: 'listAgents', readOnly: true, toolset: 'agents', note}]}, denylist).errors.join()).toMatch(/note must be a non-empty string/);
    }
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
      'createCouponBatch', 'createMyStoreCoupon', 'redeemBalanceCoupon', 'createKnowledgeSource', 'reindexKnowledgeSource', 'deleteKnowledgeSource', 'updateKnowledgeSync', 'reserveCoupon', 'validateCoupon', 'confirmCouponRedemption', 'releaseCouponRedemption',
      'deleteTask', 'deleteTaskAttachment', 'quoteCashOutPayout', 'requestCashOutPayout']) {
      expect(names.has(excluded)).toBe(false);
    }
  });
  it('el secreto de medición de la analítica se quita de la respuesta', () => {
    expect(API_TOOLS.find((t) => t.name === 'getAnalyticsStatus')!.redact).toEqual(['mp_secret_id', 'mp_secret_masked']);
  });
});
