import {readFileSync, existsSync} from 'node:fs';
import {describe, expect, it} from 'vitest';

// @ts-expect-error plain ESM script without types
import {buildTools, loadSpec, indexOperations, sensitiveKeys} from '../scripts/build-tools.mjs';
import {API_TOOLS} from '../src/generated/tools.js';

const manifest = JSON.parse(readFileSync(new URL('../tools.manifest.json', import.meta.url), 'utf8'));
const denylist = JSON.parse(readFileSync(new URL('../denylist.json', import.meta.url), 'utf8'));
const specFile = new URL('../openapi/1platform-api.json', import.meta.url);
const haveSpec = existsSync(specFile);

describe('T-8 the manifest is a subset of the spec and does not touch the denylist', () => {
  it.runIf(haveSpec)('every operationId exists and none is denied', () => {
    const {tools, errors} = buildTools(loadSpec(specFile), manifest, denylist);
    expect(errors).toEqual([]);
    expect(tools.map((t: {name: string}) => t.name)).toEqual(manifest.tools.map((t: {operationId: string}) => t.operationId));
  });

  it.runIf(haveSpec)('a denied operation in the manifest fails the build (control)', () => {
    const bad = {tools: [...manifest.tools, {operationId: 'createInvoice', readOnly: false}]};
    expect(buildTools(loadSpec(specFile), bad, denylist).errors).toContainEqual(expect.stringContaining('createInvoice: in the denylist'));
    const byPath = {tools: [{operationId: 'getWebhookConfig', readOnly: true}]};
    const noIds = {...denylist, operationIds: []};
    expect(buildTools(loadSpec(specFile), byPath, noIds).errors).toContainEqual(expect.stringContaining('path prefix /api/v1/webhooks'));
  });

  it.runIf(haveSpec)('an operationId that is not in the spec fails the build (control)', () => {
    expect(buildTools(loadSpec(specFile), {tools: [{operationId: 'inventedOperation', readOnly: true}]}, denylist).errors).toEqual(['inventedOperation: not in the OpenAPI']);
  });

  it('the generated tools are the manifest, nothing more', () => {
    expect(API_TOOLS.map((t) => t.name).sort()).toEqual(manifest.tools.map((t: {operationId: string}) => t.operationId).sort());
    for (const tool of API_TOOLS) {
      expect(denylist.operationIds).not.toContain(tool.name);
      for (const prefix of denylist.pathPrefixes) expect(tool.path === prefix || tool.path.startsWith(`${prefix}/`)).toBe(false);
    }
  });

  it.runIf(haveSpec)('the committed src/generated/tools.ts is what the spec produces', async () => {
    // @ts-expect-error plain ESM script without types
    const {render} = await import('../scripts/build-tools.mjs');
    const {tools} = buildTools(loadSpec(specFile), manifest, denylist);
    expect(readFileSync(new URL('../src/generated/tools.ts', import.meta.url), 'utf8')).toBe(render(tools));
  });
});

describe('T-9 no header parameter reaches an input schema', () => {
  it('no Authorization, x-user-token or Idempotency-Key', () => {
    for (const tool of API_TOOLS) {
      const names = Object.keys(tool.inputSchema.properties).map((n) => n.toLowerCase());
      expect(names).not.toContain('x-user-token');
      expect(names).not.toContain('authorization');
      expect(names).not.toContain('idempotency-key');
    }
  });

  it.runIf(haveSpec)('every manifest operation declares x-user-token as a header in the spec (the strip is doing work)', () => {
    const ops = indexOperations(loadSpec(specFile));
    for (const tool of API_TOOLS) {
      const params = (ops.get(tool.name).op.parameters ?? []) as Array<{in: string; name: string}>;
      expect(params.some((p) => p.in === 'header' && p.name === 'x-user-token')).toBe(true);
    }
  });
});

describe('T-10 omit', () => {
  it('createPaymentLink does not expose customer_email', () => {
    const tool = API_TOOLS.find((t) => t.name === 'createPaymentLink')!;
    expect(Object.keys(tool.inputSchema.properties)).not.toContain('customer_email');
    expect(tool.bodyParams).not.toContain('customer_email');
    expect(tool.inputSchema.properties).toHaveProperty('amount');
  });
});

describe('T-22 redaction of sensitive response keys', () => {
  it.runIf(haveSpec)('every sensitive-looking response key is redacted or reviewed', () => {
    expect(buildTools(loadSpec(specFile), manifest, denylist).errors).toEqual([]);
  });

  it.runIf(haveSpec)('dropping a redact entry fails the build (control)', () => {
    const bad = {tools: manifest.tools.map((t: {operationId: string; redact?: string[]}) => (t.operationId === 'getWebsite' ? {...t, redact: []} : t))};
    expect(buildTools(loadSpec(specFile), bad, denylist).errors).toContainEqual(expect.stringContaining('getWebsite: response key "token" looks sensitive'));
  });

  it('a new *_secret key in a schema is detected', () => {
    expect([...sensitiveKeys({type: 'object', properties: {data: {type: 'object', properties: {signing_secret: {type: 'string'}}}}})]).toEqual(['signing_secret']);
  });
});
