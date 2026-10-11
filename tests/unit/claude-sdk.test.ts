import { describe, expect, test, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * ARCH-4: the Agent SDK client, with `query()` replaced so no test calls the
 * real API. The test checks the options the app passes against the current
 * SDK documentation (code.claude.com/docs/en/agent-sdk/typescript) and how
 * SDK messages become the app's events.
 */
const calls: { prompt: unknown; options: Record<string, unknown> }[] = [];
let script: unknown[] = [];
const closed = vi.fn();

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (params: { prompt: unknown; options: Record<string, unknown> }) => {
    calls.push(params);
    const messages = script;
    return {
      async *[Symbol.asyncIterator]() {
        for (const m of messages) yield m;
      },
      close: closed,
    };
  },
  tool: (name: string, description: string, shape: unknown, handler: unknown, extras: unknown) => ({
    name,
    description,
    shape,
    handler,
    extras,
  }),
  createSdkMcpServer: (o: { name: string; tools: unknown[] }) => ({
    type: 'sdk',
    name: o.name,
    tools: o.tools,
  }),
}));

const { SdkClaudeClient, DENIED_BUILTINS, subprocessEnv } =
  await import('../../src/main/claude/sdk');
const { ClaudeFailure } = await import('../../src/main/claude/client');
const { systemPrompt, PROSE_PROHIBITION } = await import('../../src/main/claude/prompts');

const KEY = 'sk-ant-api03-test-key-abcdefghijklmnop';
const opts = { configDir: join(tmpdir(), 'nc-claude-test'), clientApp: 'novel-companion/test' };

const request = (over: Record<string, unknown> = {}) => ({
  feature: 'panel' as const,
  model: 'claude-sonnet-5-5',
  apiKey: KEY,
  system: systemPrompt('Answer questions.'),
  prompt: 'The writer asks:\nHow old is Margaret?',
  tools: [
    {
      name: 'get_entry',
      description: 'Read one entry.',
      shape: { id: z.string() },
      readOnly: true,
      handler: async () => ({ text: '{}' }),
    },
  ],
  maxTurns: 12,
  ...over,
});

async function drain(it: AsyncIterable<unknown>) {
  const out: unknown[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const success = (extra: Record<string, unknown> = {}) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'Margaret is 82.',
  ...extra,
});

describe('ARCH-4 the Claude Agent SDK client', () => {
  test('ARCH-4 query() gets the model, the prohibition prompt, no built-in tools, only the app tools, dontAsk, and the key only in the subprocess environment', async () => {
    calls.length = 0;
    script = [success()];
    const client = new SdkClaudeClient(opts);
    await drain(client.run(request(), new AbortController().signal));
    expect(calls).toHaveLength(1);
    const o = calls[0]!.options;
    expect(o.model).toBe('claude-sonnet-5-5');
    expect(String(o.systemPrompt)).toContain(PROSE_PROHIBITION);
    expect(o.tools).toEqual([]);
    expect(o.allowedTools).toEqual(['mcp__bible__get_entry']);
    expect(o.disallowedTools).toEqual(DENIED_BUILTINS);
    expect(DENIED_BUILTINS).toEqual(
      expect.arrayContaining(['Bash', 'Write', 'Edit', 'WebFetch', 'WebSearch', 'Read']),
    );
    expect(o.permissionMode).toBe('dontAsk');
    expect(o.settingSources).toEqual([]);
    expect(o.persistSession).toBe(false);
    expect(o.includePartialMessages).toBe(true);
    expect(o.maxTurns).toBe(12);
    expect(o.strictMcpConfig).toBe(true);
    expect(Object.keys(o.mcpServers as object)).toEqual(['bible']);
    expect(o.abortController).toBeInstanceOf(AbortController);
    const env = o.env as Record<string, string>;
    expect(env.ANTHROPIC_API_KEY).toBe(KEY);
    expect(env.CLAUDE_CONFIG_DIR).toBe(opts.configDir);
    // The key is in exactly one variable, and nowhere in the prompt or options otherwise.
    expect(Object.values(env).filter((v) => v.includes(KEY))).toHaveLength(1);
    expect(
      JSON.stringify({ ...o, env: null, abortController: null, mcpServers: null }),
    ).not.toContain(KEY);
    expect(closed).toHaveBeenCalled();
  });

  test('ARCH-4 the in-process tools are marked read-only except propose_change, by their own flag', async () => {
    calls.length = 0;
    script = [success()];
    const client = new SdkClaudeClient(opts);
    await drain(client.run(request(), new AbortController().signal));
    const server = (
      calls[0]!.options.mcpServers as Record<string, { tools: { extras: unknown }[] }>
    ).bible!;
    expect(server.tools[0]!.extras).toEqual({ annotations: { readOnlyHint: true } });
  });

  test('ARCH-4 a feature with an output schema passes outputFormat json_schema and returns structured_output', async () => {
    calls.length = 0;
    const structured = { summary: 'ok', proposals: [] };
    script = [success({ result: '', structured_output: structured })];
    const client = new SdkClaudeClient(opts);
    const schema = { type: 'object', properties: { summary: { type: 'string' } } };
    const events = await drain(
      client.run(
        request({ feature: 'importProposals', tools: [], outputSchema: schema }),
        new AbortController().signal,
      ),
    );
    expect(calls[0]!.options.outputFormat).toEqual({ type: 'json_schema', schema });
    expect(calls[0]!.options.mcpServers).toEqual({});
    expect(events.at(-1)).toEqual({ type: 'result', text: '', structured });
  });

  test('ARCH-4 AI-1 streamed text deltas become text events; tool calls are reported; sub-agent text is not', async () => {
    script = [
      {
        type: 'stream_event',
        parent_tool_use_id: null,
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Margaret ' },
        },
      },
      {
        type: 'stream_event',
        parent_tool_use_id: 'toolu_1',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'hidden' },
        },
      },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 't1', name: 'mcp__bible__get_entry', input: { id: 'H1' } },
          ],
        },
        parent_tool_use_id: null,
      },
      {
        type: 'stream_event',
        parent_tool_use_id: null,
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'is 82.' },
        },
      },
      success(),
    ];
    const events = await drain(
      new SdkClaudeClient(opts).run(request(), new AbortController().signal),
    );
    expect(events).toEqual([
      { type: 'text', text: 'Margaret ' },
      { type: 'toolCall', name: 'mcp__bible__get_entry', input: { id: 'H1' } },
      { type: 'text', text: 'is 82.' },
      { type: 'result', text: 'Margaret is 82.', structured: null },
    ]);
  });

  test('ARCH-4 AI-7 a rejected key, a rate limit, and a missing model become typed failures', async () => {
    const kindOf = async (messages: unknown[]) => {
      script = messages;
      try {
        await drain(new SdkClaudeClient(opts).run(request(), new AbortController().signal));
        return 'none';
      } catch (e) {
        return e instanceof ClaudeFailure ? e.kind : 'untyped';
      }
    };
    expect(
      await kindOf([
        {
          type: 'assistant',
          error: 'authentication_failed',
          message: { content: [] },
          parent_tool_use_id: null,
        },
      ]),
    ).toBe('badKey');
    expect(
      await kindOf([success({ is_error: true, api_error_status: 429, result: 'Rate limited' })]),
    ).toBe('rateLimit');
    expect(
      await kindOf([
        {
          type: 'assistant',
          error: 'model_not_found',
          message: { content: [] },
          parent_tool_use_id: null,
        },
      ]),
    ).toBe('modelUnavailable');
    expect(
      await kindOf([
        {
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          errors: ['getaddrinfo ENOTFOUND api.anthropic.com'],
        },
      ]),
    ).toBe('network');
    expect(await kindOf([])).toBe('other');
  });

  test('AI-1 an aborted run ends without a result and without throwing', async () => {
    script = [success()];
    const c = new AbortController();
    c.abort();
    expect(await drain(new SdkClaudeClient(opts).run(request(), c.signal))).toEqual([]);
  });

  test('ARCH-5 ARCH-7 the subprocess environment is built from nothing: no inherited secrets, telemetry and error reporting off', () => {
    process.env.SOME_OTHER_SECRET = 'do-not-pass';
    process.env.ANTHROPIC_BASE_URL = 'https://example.invalid';
    const env = subprocessEnv(KEY, opts);
    expect(env.SOME_OTHER_SECRET).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.DISABLE_TELEMETRY).toBe('1');
    expect(env.DISABLE_ERROR_REPORTING).toBe('1');
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1');
    delete process.env.SOME_OTHER_SECRET;
    delete process.env.ANTHROPIC_BASE_URL;
  });
});
