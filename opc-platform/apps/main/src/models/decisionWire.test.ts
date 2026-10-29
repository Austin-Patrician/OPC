import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ModelDefaults, ProviderConfig } from '@opc/shared/domain';
import type { ModelConfigRepository } from '../data/modelConfigRepository';
import { DecisionService } from './decisionService';
import type { ModelConfigService } from './modelConfigService';
import { ModelRuntime } from './runtime';

/**
 * Exercises the real pi classifier adapter over HTTP. The unit tests above mock
 * `runtime.classify`, so without this seam a wrong URL, body shape or answer
 * field would only show up against a paid provider.
 */
let server: http.Server;
let baseUrl = '';

let lastPath = '';
let lastAuth = '';
let lastBody: unknown = null;
let mode: 'ok' | 'unauthorized' = 'ok';

const config = (): ProviderConfig => ({
  id: 'typesafe',
  name: 'TypeSafe',
  baseUrl,
  api: 'typesafe-system-one',
  isCustom: false,
  hasKey: true,
  models: [
    {
      id: 'jev-latest',
      name: 'Jev',
      capability: 'classifier',
      api: 'typesafe-system-one',
      decisionEnabled: true,
    },
  ],
  updatedAt: 0,
});

const defaults = (): ModelDefaults => ({
  llm: null,
  image: null,
  asr: null,
  tts: null,
  decision: { providerId: 'typesafe', modelId: 'jev-latest' },
});

function decisions() {
  const providers = [config()];
  const repository = { listProviders: () => providers } as unknown as ModelConfigRepository;
  const runtime = new ModelRuntime(repository, () => 'test-key');
  const models = {
    listProviders: () => providers,
    getDefaults: defaults,
    runtime,
  } as unknown as ModelConfigService;
  return new DecisionService(models);
}

beforeAll(async () => {
  server = http.createServer((request, response) => {
    lastPath = request.url ?? '';
    lastAuth = String(request.headers.authorization ?? '');
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      lastBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;

      if (mode === 'unauthorized') {
        response.writeHead(401, { 'content-type': 'application/json' }).end(
          JSON.stringify({ error: { message: 'invalid key' } }),
        );
        return;
      }

      if (request.url !== '/v1/systemone') {
        response.writeHead(404).end();
        return;
      }

      response.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          model: 'jev-1.14.0',
          answers: {
            urgent: { type: 'noul', noul: 0.82 },
            category: {
              type: 'choice',
              choice: 'billing',
              confidence: 0.91,
              probabilities: { billing: 0.91, technical: 0.09 },
            },
            severity: { type: 'score', score: 2, confidence: 0.7 },
          },
          usage: { input_tokens: 42, output_tokens: 0 },
        }),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const questions = {
  urgent: {
    type: 'bool' as const,
    instructions: 'Is this urgent?',
    criteria: { true: 'Needs action today', false: 'Can wait' },
  },
  category: {
    type: 'choice' as const,
    instructions: 'What kind of message is this?',
    criteria: { billing: 'Billing', technical: 'Technical' },
  },
  severity: {
    type: 'score' as const,
    instructions: 'How severe is it?',
    criteria: ['Low', 'Medium', 'High'],
  },
};

describe('DecisionService over the System One wire', () => {
  it('posts state + questions to /systemone and parses probability answers', async () => {
    mode = 'ok';

    const result = await decisions().classify({
      state: 'The invoice charged twice.',
      questions,
    });

    expect(lastPath).toBe('/v1/systemone');
    expect(lastAuth).toBe('Bearer test-key');
    expect(lastBody).toEqual({
      model: 'jev-latest',
      // pi maps the public `bool` name to TypeSafe's wire-level `noul`.
      state: { text: 'The invoice charged twice.' },
      questions: {
        urgent: { ...questions.urgent, type: 'noul' },
        category: questions.category,
        severity: questions.severity,
      },
    });
    expect(result).toEqual({
      ok: true,
      model: 'jev-latest',
      answers: {
        urgent: { type: 'bool', probability: 0.82 },
        category: {
          type: 'choice',
          choice: 'billing',
          confidence: 0.91,
          probabilities: { billing: 0.91, technical: 0.09 },
        },
        severity: { type: 'score', score: 2, confidence: 0.7 },
      },
      usage: { inputTokens: 42, outputTokens: 0 },
    });
  });

  it('surfaces the provider HTTP error instead of inventing an answer', async () => {
    mode = 'unauthorized';

    const result = await decisions().classify({
      state: 'The invoice charged twice.',
      questions,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('401');
  });
});
