/**
 * ClaudeCodeAdapterLive - Live implementation for the Claude Code provider adapter.
 *
 * Wraps `ClaudeAgentManager` behind the `ClaudeCodeAdapter` service contract and
 * maps manager events into the shared `ProviderRuntimeEvent` algebra.
 *
 * @module ClaudeCodeAdapterLive
 */
import {
  type CanonicalItemType,
  EventId,
  type ProviderEvent,
  type ProviderRuntimeEvent,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { randomUUID } from "node:crypto";
import { Effect, Layer, Queue, Stream } from "effect";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { ClaudeCodeAdapter, type ClaudeCodeAdapterShape } from "../Services/ClaudeCodeAdapter.ts";
import {
  ClaudeAgentManager,
  type ClaudeAgentManagerStartSessionInput,
} from "../../claudeAgentManager.ts";
import { ServerConfig } from "../../config.ts";
import { type EventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = "claude-code" as const;

export interface ClaudeCodeAdapterLiveOptions {
  readonly manager?: ClaudeAgentManager;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  return fallback;
}

function toSessionError(
  threadId: ThreadId,
  cause: unknown,
): ProviderAdapterSessionNotFoundError | ProviderAdapterSessionClosedError | undefined {
  const normalized = toMessage(cause, "").toLowerCase();
  if (normalized.includes("unknown session") || normalized.includes("unknown provider session")) {
    return new ProviderAdapterSessionNotFoundError({
      provider: PROVIDER,
      threadId,
      cause,
    });
  }
  if (normalized.includes("session is closed")) {
    return new ProviderAdapterSessionClosedError({
      provider: PROVIDER,
      threadId,
      cause,
    });
  }
  return undefined;
}

function toRequestError(threadId: ThreadId, method: string, cause: unknown): ProviderAdapterError {
  const sessionError = toSessionError(threadId, cause);
  if (sessionError) {
    return sessionError;
  }
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: toMessage(cause, `${method} failed`),
    cause,
  });
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function toolNameToItemType(toolName: string): CanonicalItemType {
  switch (toolName) {
    case "Bash":
      return "command_execution";
    case "Edit":
    case "Write":
    case "NotebookEdit":
    case "Read":
    case "Grep":
    case "Glob":
      return "file_change";
    case "WebSearch":
    case "WebFetch":
      return "web_search";
    case "Task":
    case "SendMessage":
    case "TeamCreate":
    case "TeamDelete":
      return "collab_agent_tool_call";
    case "EnterPlanMode":
    case "ExitPlanMode":
    case "TaskCreate":
    case "TaskUpdate":
    case "TaskGet":
    case "TaskList":
    case "TodoWrite":
    case "TodoRead":
      return "plan";
    default:
      // MCP tools are prefixed with "mcp__"
      if (toolName.startsWith("mcp__") || toolName.startsWith("mcp_")) {
        return "mcp_tool_call";
      }
      return "dynamic_tool_call";
  }
}

const PROPOSED_PLAN_BLOCK_REGEX = /<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/i;

function extractProposedPlanMarkdown(text: string | undefined): string | undefined {
  const match = text ? PROPOSED_PLAN_BLOCK_REGEX.exec(text) : null;
  const planMarkdown = match?.[1]?.trim();
  return planMarkdown && planMarkdown.length > 0 ? planMarkdown : undefined;
}

function runtimeEventBase(
  event: Partial<ProviderEvent> & { id: string; kind: string },
  canonicalThreadId: ThreadId,
): Omit<ProviderRuntimeEvent, "type" | "payload"> {
  return {
    eventId: event.id,
    provider: PROVIDER,
    threadId: canonicalThreadId,
    createdAt: event.createdAt ?? new Date().toISOString(),
    ...(event.turnId ? { turnId: event.turnId as TurnId } : {}),
    ...(event.itemId
      ? { itemId: RuntimeItemId.makeUnsafe(event.itemId as string) }
      : {}),
    ...(event.requestId
      ? { requestId: RuntimeRequestId.makeUnsafe(event.requestId as string) }
      : {}),
    raw: {
      source: "claude-code.sdk.message" as const,
      method: (event as { method?: string }).method ?? "unknown",
      payload: event.payload ?? {},
    },
  };
}

function mapToRuntimeEvents(
  event: Partial<ProviderEvent> & { id: string; kind: string },
  canonicalThreadId: ThreadId,
): ReadonlyArray<ProviderRuntimeEvent> {
  const method = (event as { method?: string }).method ?? "";
  const payload = asObject(event.payload);

  if (event.kind === "error") {
    if (!(event as { message?: string }).message) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "runtime.error",
        payload: {
          message: (event as { message?: string }).message!,
          class: "provider_error",
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (method === "session/started") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.started" as const,
        payload: {
          ...((event as { message?: string }).message
            ? { message: (event as { message?: string }).message }
            : {}),
          ...(event.payload !== undefined ? { resume: event.payload } : {}),
        },
      },
    ];
  }

  if (method === "session/configured") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.configured" as const,
        payload: {
          config: (event.payload ?? {}) as { readonly [x: string]: unknown },
        },
      },
    ];
  }

  if (method === "session/exited") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.exited",
        payload: {
          reason: (event as { message?: string }).message,
        },
      },
    ];
  }

  if (method === "session/updated") {
    const sessionPayload = asObject(event.payload);
    const rawState = asString(sessionPayload?.status);
    const validStates = ["starting", "ready", "running", "waiting", "stopped", "error"] as const;
    const state = validStates.find((s) => s === rawState) ?? "ready";
    const reason = asString(sessionPayload?.lastError);
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.state.changed" as const,
        payload: {
          state,
          ...(reason ? { reason } : {}),
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (method === "turn/started") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.started",
        payload: {},
      },
    ];
  }

  if (method === "turn/completed") {
    const status = asString(payload?.status) ?? "completed";
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.completed",
        payload: {
          state: status === "failed" ? "failed" : status === "interrupted" ? "interrupted" : "completed",
          ...(asString(payload?.error) ? { errorMessage: asString(payload?.error) } : {}),
        },
      },
    ];
  }

  if (method === "turn/interrupted") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.aborted",
        payload: {
          reason: (event as { message?: string }).message ?? "Turn interrupted",
        },
      },
    ];
  }

  if (method === "item/agentMessage/delta") {
    const textDelta = (event as { textDelta?: string }).textDelta;
    if (!textDelta || textDelta.length === 0) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "content.delta",
        payload: {
          streamKind: "assistant_text",
          delta: textDelta,
        },
      },
    ];
  }

  if (method === "item/reasoning/textDelta") {
    const textDelta = (event as { textDelta?: string }).textDelta;
    if (!textDelta || textDelta.length === 0) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "content.delta",
        payload: {
          streamKind: "reasoning_text",
          delta: textDelta,
        },
      },
    ];
  }

  if (method === "item/tool/started") {
    const toolName = asString(payload?.toolName) ?? "unknown";
    const itemType = toolNameToItemType(toolName);
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "item.started",
        payload: {
          itemType,
          status: "inProgress",
          title: toolName,
          ...(asString(payload?.toolId) ? { toolUseId: asString(payload?.toolId) } : {}),
          ...(event.payload !== undefined ? { data: event.payload } : {}),
        },
      },
    ];
  }

  if (method === "item/tool/completed") {
    const toolName = asString(payload?.toolName) ?? "unknown";
    const itemType = toolNameToItemType(toolName);
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "item.completed",
        payload: {
          itemType,
          title: toolName,
          ...(asString(payload?.toolId) ? { toolUseId: asString(payload?.toolId) } : {}),
          ...(event.payload !== undefined ? { data: event.payload } : {}),
        },
      },
    ];
  }

  if (method === "tool/progress") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "tool.progress",
        payload: {
          ...(asString(payload?.toolName) ? { toolName: asString(payload?.toolName) } : {}),
          ...(asString(payload?.summary) ? { summary: asString(payload?.summary) } : {}),
        },
      },
    ];
  }

  if (method === "user-input/requested") {
    const questions = payload?.questions;
    if (!Array.isArray(questions) || questions.length === 0) return [];
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "user-input.requested" as const,
        payload: {
          questions: questions as ReadonlyArray<{
            readonly id: string;
            readonly header: string;
            readonly question: string;
            readonly options: ReadonlyArray<{
              readonly label: string;
              readonly description: string;
            }>;
          }>,
        },
      },
    ];
  }

  if (method === "request/opened") {
    const reqPayload = asObject(event.payload);
    const rawRequestType = asString(reqPayload?.requestType) ?? "unknown";
    const validRequestTypes = [
      "command_execution_approval",
      "file_read_approval",
      "file_change_approval",
      "apply_patch_approval",
      "exec_command_approval",
      "tool_user_input",
      "dynamic_tool_call",
      "auth_tokens_refresh",
      "unknown",
    ] as const;
    const requestType = validRequestTypes.find((t) => t === rawRequestType) ?? "unknown";
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "request.opened" as const,
        payload: {
          requestType,
          ...(asString(reqPayload?.detail) ? { detail: asString(reqPayload?.detail) } : {}),
          ...(reqPayload?.args !== undefined ? { args: reqPayload?.args } : {}),
        },
      },
    ];
  }

  if (method === "request/resolved") {
    const requestPayload = asObject(event.payload);
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "request.resolved" as const,
        payload: {
          requestType: (asString(requestPayload?.requestType) ?? "unknown") as "unknown",
          ...(asString(requestPayload?.decision) ? { decision: asString(requestPayload?.decision) } : {}),
          ...(requestPayload?.resolution !== undefined ? { resolution: requestPayload.resolution } : {}),
        },
      },
    ];
  }

  if (method === "user-input/resolved") {
    const inputPayload = asObject(event.payload);
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "user-input.resolved" as const,
        payload: {
          answers: (inputPayload?.answers ?? {}) as { readonly [x: string]: unknown },
        },
      },
    ];
  }

  // For any other SDK messages, emit as generic events
  if (method.startsWith("sdk/")) {
    return [];
  }

  return [];
}

export function makeClaudeCodeAdapterLive(
  options?: ClaudeCodeAdapterLiveOptions,
) {
  return Layer.effect(
    ClaudeCodeAdapter,
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const manager = options?.manager ?? new ClaudeAgentManager();
      const eventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();

      // Buffer assistant text per thread for proposed plan extraction on turn completion
      const assistantTextBuffer = new Map<string, string>();

      // Wire manager events to the queue
      manager.on("event", (event: Partial<ProviderEvent> & { id: string; kind: string }) => {
        const threadId = (event as { threadId?: string }).threadId;
        if (!threadId) return;

        const canonicalThreadId = threadId as ThreadId;
        const method = (event as { method?: string }).method ?? "";

        if (options?.nativeEventLogger) {
          void Effect.runPromise(
            options.nativeEventLogger.write(event, canonicalThreadId),
          );
        }

        // Buffer assistant text deltas for proposed plan extraction
        if (method === "item/agentMessage/delta") {
          const textDelta = (event as { textDelta?: string }).textDelta;
          if (textDelta) {
            const existing = assistantTextBuffer.get(threadId) ?? "";
            assistantTextBuffer.set(threadId, existing + textDelta);
          }
        }

        // Clear buffer on new turn
        if (method === "turn/started") {
          assistantTextBuffer.delete(threadId);
        }

        const runtimeEvents = mapToRuntimeEvents(event, canonicalThreadId);

        // On turn completion, check for proposed plan in buffered assistant text
        if (method === "turn/completed") {
          const bufferedText = assistantTextBuffer.get(threadId);
          assistantTextBuffer.delete(threadId);
          const planMarkdown = extractProposedPlanMarkdown(bufferedText);
          if (planMarkdown) {
            const planEvent: ProviderRuntimeEvent = {
              eventId: EventId.makeUnsafe(randomUUID()),
              provider: PROVIDER,
              threadId: canonicalThreadId,
              createdAt: new Date().toISOString(),
              ...(event.turnId ? { turnId: event.turnId as TurnId } : {}),
              type: "turn.proposed.completed",
              payload: {
                planMarkdown,
              },
              raw: {
                source: "claude-code.sdk.message" as const,
                method: "turn.proposed.completed",
                payload: { planMarkdown },
              },
            };
            void Effect.runPromise(Queue.offerAll(eventQueue, [...runtimeEvents, planEvent]));
            return;
          }
        }

        void Effect.runPromise(Queue.offerAll(eventQueue, runtimeEvents));
      });

      const adapter: ClaudeCodeAdapterShape = {
        provider: PROVIDER,
        capabilities: {
          sessionModelSwitch: "restart-session",
        },

        startSession: (input) =>
          Effect.tryPromise({
            try: async () => {
              const startInput: ClaudeAgentManagerStartSessionInput = {
                threadId: input.threadId,
                cwd: input.cwd ?? config.cwd,
                model: input.model,
                runtimeMode: input.runtimeMode,
                binaryPath: input.providerOptions?.claudeCode?.binaryPath,
                input: "",
                resumeSessionId: asString(
                  asObject(input.resumeCursor)?.sessionId,
                ),
              };
              await manager.startSession(startInput);
              const session = manager.getSession(input.threadId);
              if (!session) {
                throw new Error("Session failed to start.");
              }
              return session;
            },
            catch: (cause) => toRequestError(input.threadId, "startSession", cause),
          }),

        sendTurn: (input) =>
          Effect.tryPromise({
            try: async () => {
              const result = await manager.sendTurn({
                threadId: input.threadId,
                input: input.input ?? "",
                model: input.model,
                interactionMode: input.interactionMode,
              });
              return {
                threadId: result.threadId,
                turnId: result.turnId as TurnId,
                ...(result.resumeCursor
                  ? { resumeCursor: result.resumeCursor }
                  : {}),
              };
            },
            catch: (cause) => toRequestError(input.threadId, "sendTurn", cause),
          }),

        interruptTurn: (threadId) =>
          Effect.tryPromise({
            try: () => manager.interruptTurn(threadId),
            catch: (cause) => toRequestError(threadId, "interruptTurn", cause),
          }),

        respondToRequest: (threadId, requestId, decision) =>
          Effect.tryPromise({
            try: () => manager.respondToRequest(threadId, requestId, decision),
            catch: (cause) => toRequestError(threadId, "respondToRequest", cause),
          }),

        respondToUserInput: (threadId, requestId, answers) =>
          Effect.tryPromise({
            try: () => manager.respondToUserInput(threadId, requestId, answers),
            catch: (cause) => toRequestError(threadId, "respondToUserInput", cause),
          }),

        stopSession: (threadId) =>
          Effect.tryPromise({
            try: () => manager.stopSession(threadId),
            catch: (cause) => toRequestError(threadId, "stopSession", cause),
          }),

        listSessions: () => Effect.sync(() => manager.listSessions()),

        hasSession: (threadId) => Effect.sync(() => manager.hasSession(threadId)),

        readThread: (threadId) =>
          Effect.tryPromise({
            try: async () => ({
              threadId,
              turns: [],
            }),
            catch: (cause) => toRequestError(threadId, "readThread", cause),
          }),

        rollbackThread: (threadId, _numTurns) =>
          Effect.tryPromise({
            try: async () => ({
              threadId,
              turns: [],
            }),
            catch: (cause) => toRequestError(threadId, "rollbackThread", cause),
          }),

        stopAll: () =>
          Effect.tryPromise({
            try: () => manager.stopAll(),
            catch: (cause) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: "*",
                detail: toMessage(cause, "Failed to stop all sessions."),
                cause,
              }),
          }),

        streamEvents: Stream.fromQueue(eventQueue),
      };

      return adapter;
    }),
  );
}
