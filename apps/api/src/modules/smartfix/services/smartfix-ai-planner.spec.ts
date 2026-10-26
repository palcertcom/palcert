import { createHash } from 'node:crypto';
import {
  AIProviderError,
  SMARTFIX_ENGINE_VERSION,
  CAPABILITY_REGISTRY_VERSION,
  type AIFormattingTarget,
} from '@palcert/contracts';
import { SmartFixAIPlannerService } from './smartfix-ai-planner.service';
import {
  DocumentEngineError,
  type PlanSmartFixResult,
} from '../../../infrastructure/document-engine/document-engine.port';

jest.mock('../../../config/api-config.service', () => ({ ApiConfigService: class {} }));
jest.mock(
  '../../auth/services/security-event.service',
  () => ({ SecurityEventService: class {} }),
  { virtual: true },
);

const request = {
  documentId: 'doc',
  content: Buffer.from('private document bytes'),
  expectedSha256: 'a'.repeat(64),
  rules: [{ ruleCode: 'SIZE' }],
  source: {},
};
const target: AIFormattingTarget = { ruleCode: 'SIZE', kind: 'NUMBER', value: '12' };
const config = { ai: { enabled: true, maxContextChars: 60_000, maxInputTokens: 60_000 } };
const audit = { ownerUserId: 'user', planId: 'reservation', requestId: null, ipAddress: null };

function result(complete = false): PlanSmartFixResult {
  const plan = {
    planSchemaVersion: 1,
    source: {
      documentVersionId: 'doc',
      documentSha256: 'a'.repeat(64),
      analysisArtifactSha256: 'b'.repeat(64),
      standardVersionId: 'std',
      standardContentHash: 'c'.repeat(64),
      reportHash: 'd'.repeat(64),
      ruleSchemaVersion: 1,
      factSchemaVersion: 1,
    },
    engine: {
      fixEngineName: 'palcert-docx-fixer',
      fixEngineVersion: SMARTFIX_ENGINE_VERSION,
      capabilityRegistryVersion: CAPABILITY_REGISTRY_VERSION,
    },
    rules: [
      {
        ruleCode: 'SIZE',
        fixability: complete ? 'FIXABLE' : 'NOT_SUPPORTED',
        targetCount: 1,
        fixableTargetCount: complete ? 1 : 0,
        actionIds: complete ? ['a-1'] : [],
      },
    ],
    actions: complete
      ? [
          {
            actionId: 'a-1',
            ruleCode: 'SIZE',
            actionType: 'SET_RUN_FONT_SIZE',
            targetScope: 'RUN_PROPERTIES',
            nodeId: 'main/body/p:1/r:1',
            scriptChannel: 'LATIN',
            after: { kind: 'NUMBER', number: '12', unit: 'POINT' },
          },
        ]
      : [],
  };
  return {
    plan,
    planBytes: Buffer.from(JSON.stringify(plan)),
    planSha256: 'a'.repeat(64),
    ruleCount: 1,
    actionCount: complete ? 1 : 0,
    refusal: null,
    fixEngineName: 'palcert-docx-fixer',
    fixEngineVersion: SMARTFIX_ENGINE_VERSION,
    capabilityRegistryVersion: CAPABILITY_REGISTRY_VERSION,
    durationMs: 1,
    aiContext: {
      schemaVersion: 1,
      complete,
      rules: [
        {
          ruleCode: 'SIZE',
          editable: true,
          outcome: complete ? 'PASS' : 'FAIL',
          targetKind: 'NUMBER',
          targetUnit: 'POINT',
        },
      ],
    },
  };
}

function fixture(outputs: AIFormattingTarget[][] = [[target]], results = [result(), result(true)]) {
  let invocation = 0;
  let planning = 0;
  const provider = {
    getCapabilities: () => ({ provider: 'test-provider', configuredModel: 'configured-model' }),
    countTokens: jest.fn(async () => ({ inputTokens: 200, exact: true })),
    proposeFormatting: jest.fn(async () => ({
      output: { targets: outputs[Math.min(invocation++, outputs.length - 1)] },
      usage: { inputTokens: 200, outputTokens: 50 },
    })),
  };
  const engine = {
    planSmartFix: jest.fn(async () => results[Math.min(planning++, results.length - 1)]!),
  };
  const billing = { assertReservationLive: jest.fn(async () => {}) };
  const service = new SmartFixAIPlannerService(
    config as never,
    provider as never,
    engine as never,
    { audit: jest.fn() } as never,
    billing as never,
  );
  return { service, provider, engine, billing };
}

describe('AI formatting orchestration', () => {
  it('requires a reservation context before any provider work', async () => {
    const { service, provider } = fixture();
    await expect(service.plan(request)).rejects.toMatchObject({ code: 'SMARTFIX_NOT_AVAILABLE' });
    expect(provider.countTokens).not.toHaveBeenCalled();
    expect(provider.proposeFormatting).not.toHaveBeenCalled();
  });
  it('stops before token counting when reserved credit is no longer live', async () => {
    const { service, provider, billing } = fixture();
    billing.assertReservationLive.mockRejectedValue(new Error('reservation expired'));
    await expect(service.plan(request, audit)).rejects.toThrow('reservation expired');
    expect(provider.countTokens).not.toHaveBeenCalled();
    expect(provider.proposeFormatting).not.toHaveBeenCalled();
  });
  it('checks credit again between token counting and generation', async () => {
    const { service, provider, billing } = fixture();
    billing.assertReservationLive
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('cancelled'));
    await expect(service.plan(request, audit)).rejects.toThrow('cancelled');
    expect(provider.countTokens).toHaveBeenCalledTimes(1);
    expect(provider.proposeFormatting).not.toHaveBeenCalled();
  });
  it('rejects disabled AI before reading the document or calling the provider', async () => {
    const { provider, engine } = fixture();
    const service = new SmartFixAIPlannerService(
      { ai: { enabled: false } } as never,
      provider as never,
      engine as never,
      {} as never,
      {} as never,
    );
    await expect(service.plan(request, audit)).rejects.toMatchObject({ code: 'AI_DISABLED' });
    expect(engine.planSmartFix).not.toHaveBeenCalled();
    expect(provider.proposeFormatting).not.toHaveBeenCalled();
  });

  it('rejects claimed completion when any original rule is missing or unresolved', async () => {
    const { service, provider, engine } = fixture();
    engine.planSmartFix.mockResolvedValue({
      ...result(),
      aiContext: {
        schemaVersion: 1,
        complete: true,
        rules: [{ ruleCode: 'SIZE', editable: true, outcome: 'FAIL' }],
      },
    });
    await expect(service.plan(request, audit)).rejects.toMatchObject({
      code: 'SMARTFIX_NOT_AVAILABLE',
    });
    engine.planSmartFix.mockResolvedValue({
      ...result(),
      aiContext: {
        schemaVersion: 1,
        complete: true,
        rules: [{ ruleCode: 'OTHER', editable: true, outcome: 'PASS' }],
      },
    });
    await expect(service.plan(request, audit)).rejects.toMatchObject({
      code: 'SMARTFIX_NOT_AVAILABLE',
    });
    expect(provider.proposeFormatting).not.toHaveBeenCalled();
  });
  it('asks AI, compiles from original bytes, and records only engine-verified completion', async () => {
    const { service, provider, engine } = fixture();
    const planned = await service.plan(request, audit);
    expect(provider.proposeFormatting).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(provider.proposeFormatting.mock.calls)).not.toContain(
      'private document bytes',
    );
    expect(engine.planSmartFix).toHaveBeenLastCalledWith(
      expect.objectContaining({
        content: request.content,
        rules: request.rules,
        aiTargets: [target],
        includeAIContext: true,
      }),
    );
    expect(planned.plan.aiPlanning).toMatchObject({
      rounds: 1,
      stopReason: 'VERIFIED',
      provider: 'test-provider',
      model: 'configured-model',
      inputTokens: 200,
    });
    expect(planned.planSha256).toBe(createHash('sha256').update(planned.planBytes).digest('hex'));
  });

  it('returns unresolved evidence to AI and accepts a revised choice', async () => {
    const { service, provider } = fixture(
      [[{ ...target, value: '9' }], [target]],
      [result(), result(), result(true)],
    );
    const planned = await service.plan(request, audit);
    expect(provider.proposeFormatting).toHaveBeenCalledTimes(2);
    const second = (provider.proposeFormatting.mock.calls as unknown[][])[1]?.[0] as {
      userPrompt: string;
    };
    expect(JSON.parse(second.userPrompt)).toMatchObject({
      previousTargets: [{ value: '9' }],
      context: { rules: [{ outcome: 'FAIL' }] },
    });
    expect(planned.plan.aiPlanning).toMatchObject({ rounds: 2, stopReason: 'VERIFIED' });
  });

  it('rejects unknown rule IDs without passing them to the engine', async () => {
    const { service, provider, engine } = fixture([
      [{ ...target, ruleCode: 'INJECTED' }],
      [target],
    ]);
    expect((await service.plan(request, audit)).plan.aiPlanning).toMatchObject({
      rounds: 2,
      stopReason: 'VERIFIED',
    });
    expect(engine.planSmartFix).toHaveBeenCalledTimes(2);
    expect(provider.proposeFormatting).toHaveBeenCalledTimes(2);
  });

  it('bounds repeated suggestions and never turns a stalled plan into success', async () => {
    const { service, provider } = fixture([[target]], [result()]);
    expect((await service.plan(request, audit)).plan.aiPlanning).toMatchObject({
      stopReason: 'NO_PROGRESS',
    });
    expect(provider.proposeFormatting).toHaveBeenCalledTimes(2);
  });

  it('stops after three distinct unresolved rounds', async () => {
    const { service, provider } = fixture(
      ['9', '10', '11'].map((value) => [{ ...target, value }]),
      [result()],
    );
    expect((await service.plan(request, audit)).plan.aiPlanning).toMatchObject({
      rounds: 3,
      stopReason: 'ROUND_LIMIT',
    });
    expect(provider.proposeFormatting).toHaveBeenCalledTimes(3);
  });

  it('feeds rejected conflicting plans back without executing them', async () => {
    const { service, engine } = fixture([[{ ...target, value: '9' }], [target]]);
    engine.planSmartFix
      .mockReset()
      .mockResolvedValueOnce(result())
      .mockRejectedValueOnce(new DocumentEngineError('DOCUMENT', 'PLAN_INVALID', 'conflict'))
      .mockResolvedValueOnce(result(true));
    expect((await service.plan(request, audit)).plan.aiPlanning).toMatchObject({
      rounds: 2,
      stopReason: 'VERIFIED',
    });
  });

  it('does not silently fall back after provider outage', async () => {
    const { service, provider } = fixture();
    provider.proposeFormatting.mockRejectedValue(new AIProviderError('TIMEOUT', 'timeout'));
    await expect(service.plan(request, audit)).rejects.toMatchObject({
      code: 'AI_PROVIDER_UNAVAILABLE',
    });
  });

  it('refuses oversized contexts before generation', async () => {
    const { service, provider } = fixture();
    provider.countTokens.mockResolvedValue({ inputTokens: 99_999, exact: true });
    await expect(service.plan(request, audit)).rejects.toMatchObject({
      code: 'SMARTFIX_NOT_AVAILABLE',
    });
    expect(provider.proposeFormatting).not.toHaveBeenCalled();
  });

  it('does not call AI for unsafe documents or incomplete evidence', async () => {
    const { service, provider, engine } = fixture();
    engine.planSmartFix.mockResolvedValue({ ...result(), refusal: 'SMARTFIX_DOCUMENT_PROTECTED' });
    await service.plan(request, audit);
    expect(provider.proposeFormatting).not.toHaveBeenCalled();
    engine.planSmartFix.mockResolvedValue({ ...result(), aiContext: undefined });
    await expect(service.plan(request, audit)).rejects.toMatchObject({
      code: 'SMARTFIX_NOT_AVAILABLE',
    });
    expect(provider.proposeFormatting).not.toHaveBeenCalled();
  });
});
