import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ApiConfigService } from '../../config/api-config.service';
import { HttpDocumentEngine } from './http-document-engine';

const BASE = 'http://document-engine:8000';

function engine(): HttpDocumentEngine {
  return new HttpDocumentEngine({
    documentEngine: { baseUrl: BASE, readinessTimeoutMs: 1000 },
  } as unknown as ApiConfigService);
}

/** The path a FastAPI route is served at: its router's prefix plus the route. */
function mountedPath(file: string, route: string): string {
  const source = readFileSync(
    join(__dirname, '..', '..', '..', '..', '..', 'services', 'document-engine', 'app', file),
    'utf8',
  );
  const prefix = /APIRouter\(prefix="([^"]*)"/.exec(source)?.[1];
  if (prefix === undefined) throw new Error(`no router prefix in ${file}`);
  if (!source.includes(`@router.get("${route}")`)) throw new Error(`no GET ${route} in ${file}`);
  return `${prefix}${route}`;
}

describe('HttpDocumentEngine.describeDocxProperties', () => {
  const realFetch = global.fetch;
  let requested: string[];

  beforeEach(() => {
    requested = [];
    global.fetch = jest.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requested.push(url);
      // Behave like the real engine: only the mounted path exists.
      if (url !== `${BASE}/analysis/docx/capabilities`) {
        return new Response('{"detail":"Not Found"}', { status: 404 });
      }
      return new Response(
        JSON.stringify({
          properties: [
            { name: 'equationCount', scopes: ['DOCUMENT'], unit: 'COUNT', exactness: 'EXACT' },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  it('calls the capabilities route where the engine mounts it', async () => {
    const properties = await engine().describeDocxProperties();
    expect(requested).toEqual([`${BASE}/analysis/docx/capabilities`]);
    expect(properties).toEqual([
      { name: 'equationCount', scopes: ['DOCUMENT'], unit: 'COUNT', exactness: 'EXACT' },
    ]);
  });

  it('uses the path the engine’s own router declares (prefix + route)', async () => {
    await engine().describeDocxProperties();
    const path = mountedPath(join('docx', 'api.py'), '/docx/capabilities');
    expect(path).toBe('/analysis/docx/capabilities');
    expect(requested).toEqual([`${BASE}${path}`]);
  });

  it('reports a 404 as the engine error it is, rather than an empty catalogue', async () => {
    global.fetch = jest.fn(
      async () => new Response('{"detail":"Not Found"}', { status: 404 }),
    ) as typeof fetch;
    await expect(engine().describeDocxProperties()).rejects.toThrow(
      'the analyzer returned 404 for its capabilities',
    );
  });
});
