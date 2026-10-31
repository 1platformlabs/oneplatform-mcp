import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {SERVER_NAME, SERVER_VERSION} from '../src/server.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {version: string; bin: Record<string, string>};

describe('identidad publicada', () => {
  it('el servidor anuncia la misma versión que el paquete de npm', () => {
    expect(SERVER_VERSION).toBe(pkg.version);
  });
  it('nombre del servidor y del comando usan oneplatform', () => {
    expect(SERVER_NAME).toBe('oneplatform');
    expect(Object.keys(pkg.bin)).toEqual(['oneplatform-mcp']);
  });
});
