import { mkdirSync } from 'node:fs';
import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import type { McpSdkServerConfigWithInstance, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeFailure, classifyFailure } from './client';
import type { ClaudeClient, ClaudeEvent, ClaudeRequest, ClaudeTool } from './client';

/** The in-process MCP server name; tools are allowed as `mcp__bible__<name>`. */
export const TOOL_SERVER = 'bible';

/**
 * Claude Code's built-in tools, all refused. `tools: []` already removes them
 * from Claude's context; listing them here as well means a future SDK default
 * cannot bring one back (AI-3: Claude has no tool that writes anywhere).
 */
export const DENIED_BUILTINS = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'Task',
  'Agent',
  'TodoWrite',
];

export interface SdkClientOptions {
  /** A folder of the app's own for Claude Code's config, so ~/.claude is never read or written. */
  configDir: string;
  /** Set when packaged: the bundled binary inside app.asar.unpacked. */
  executablePath?: string;
  /** Identifies the app in the SDK's User-Agent header. */
  clientApp: string;
}

function mcpServer(tools: ClaudeTool[]): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: TOOL_SERVER,
    version: '1.0.0',
    tools: tools.map((t) =>
      tool(
        t.name,
        t.description,
        t.shape,
        async (args) => {
          const out = await t.handler(args as Record<string, unknown>);
          return { content: [{ type: 'text' as const, text: out.text }], isError: out.isError };
        },
        { annotations: { readOnlyHint: t.readOnly } },
      ),
    ),
  });
}

/**
 * The subprocess environment, built from nothing: the API key goes here and
 * nowhere else (ARCHITECTURE, Claude), and Claude Code's own telemetry, error
 * reporting, and update checks are off (ARCH-7).
 */
export function subprocessEnv(apiKey: string, opts: SdkClientOptions): Record<string, string> {
  const env: Record<string, string> = {
    ANTHROPIC_API_KEY: apiKey,
    CLAUDE_CONFIG_DIR: opts.configDir,
    CLAUDE_AGENT_SDK_CLIENT_APP: opts.clientApp,
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY']) {
    const v = process.env[name];
    if (v !== undefined) env[name] = v;
  }
  return env;
}

/** ARCH-4: Claude through the Claude Agent SDK from the main process. */
export class SdkClaudeClient implements ClaudeClient {
  constructor(private readonly opts: SdkClientOptions) {}

  async *run(req: ClaudeRequest, signal: AbortSignal): AsyncIterable<ClaudeEvent> {
    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    if (signal.aborted) return;
    mkdirSync(this.opts.configDir, { recursive: true });
    signal.addEventListener('abort', onAbort, { once: true });
    const q = query({
      prompt: req.prompt,
      options: {
        model: req.model,
        systemPrompt: req.system,
        tools: [],
        mcpServers: req.tools.length ? { [TOOL_SERVER]: mcpServer(req.tools) } : {},
        strictMcpConfig: true,
        allowedTools: req.tools.map((t) => `mcp__${TOOL_SERVER}__${t.name}`),
        disallowedTools: DENIED_BUILTINS,
        permissionMode: 'dontAsk',
        settingSources: [],
        persistSession: false,
        includePartialMessages: true,
        maxTurns: req.maxTurns,
        abortController,
        cwd: this.opts.configDir,
        env: subprocessEnv(req.apiKey, this.opts),
        ...(req.outputSchema
          ? { outputFormat: { type: 'json_schema' as const, schema: req.outputSchema } }
          : {}),
        ...(this.opts.executablePath
          ? { pathToClaudeCodeExecutable: this.opts.executablePath }
          : {}),
      },
    });
    try {
      for await (const m of q as AsyncIterable<SDKMessage>) {
        if (signal.aborted) return;
        const event = this.translate(m);
        if (event === 'skip') continue;
        yield event;
        if (event.type === 'result') return;
      }
      if (!signal.aborted) throw new ClaudeFailure('other');
    } catch (e) {
      if (signal.aborted) return;
      if (e instanceof ClaudeFailure) throw e;
      throw new ClaudeFailure(classifyFailure({ message: e instanceof Error ? e.message : '' }));
    } finally {
      signal.removeEventListener('abort', onAbort);
      q.close();
    }
  }

  private translate(m: SDKMessage): ClaudeEvent | 'skip' {
    switch (m.type) {
      case 'stream_event': {
        const ev = m.event;
        if (
          m.parent_tool_use_id === null &&
          ev.type === 'content_block_delta' &&
          ev.delta.type === 'text_delta'
        ) {
          return { type: 'text', text: ev.delta.text };
        }
        return 'skip';
      }
      case 'assistant': {
        if (m.error) throw new ClaudeFailure(classifyFailure({ assistantError: m.error }));
        const call = m.message.content.find((b) => b.type === 'tool_use');
        return call && call.type === 'tool_use'
          ? { type: 'toolCall', name: call.name, input: call.input }
          : 'skip';
      }
      case 'result': {
        if (m.subtype === 'success' && !m.is_error) {
          return { type: 'result', text: m.result, structured: m.structured_output ?? null };
        }
        if (m.subtype === 'error_max_structured_output_retries') {
          throw new ClaudeFailure('invalidOutput');
        }
        const apiStatus = m.subtype === 'success' ? (m.api_error_status ?? null) : null;
        const message = m.subtype === 'success' ? m.result : m.errors.join(' ');
        throw new ClaudeFailure(classifyFailure({ apiStatus, message }));
      }
      default:
        return 'skip';
    }
  }
}
