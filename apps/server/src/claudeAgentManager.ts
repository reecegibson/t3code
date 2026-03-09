/**
 * ClaudeAgentManager - Manages Claude Code sessions via the Agent SDK.
 *
 * Wraps `@anthropic-ai/claude-agent-sdk` query() to provide session lifecycle
 * management, multi-turn conversations, and event streaming. Analogous to
 * `CodexAppServerManager` for the Codex provider.
 *
 * @module ClaudeAgentManager
 */
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

import {
  EventId,
  type ApprovalRequestId,
  type ProviderApprovalDecision,
  type ProviderEvent,
  type ProviderKind,
  type ProviderSession,
  type ProviderUserInputAnswers,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";

// ── Types ────────────────────────────────────────────────────────────

export interface ClaudeSessionContext {
  session: ProviderSession;
  sessionId: string | null;
  abortController: AbortController;
  pendingApprovals: Map<string, PendingApprovalRequest>;
  pendingUserInputs: Map<string, PendingUserInputRequest>;
  /** Tool calls that have been started but not yet completed. */
  activeToolCalls: Map<string, { toolName: string; startedAt: string }>;
  activeTurnId: string | undefined;
  stopping: boolean;
}

interface PendingApprovalRequest {
  requestId: string;
  resolve: (decision: { behavior: "allow" } | { behavior: "deny"; message?: string }) => void;
}

interface PendingUserInputRequest {
  requestId: string;
  resolve: (answers: Record<string, unknown>) => void;
}

export interface ClaudeAgentManagerStartSessionInput {
  readonly threadId: ThreadId;
  readonly cwd?: string | undefined;
  readonly model?: string | undefined;
  readonly runtimeMode?: "full-access" | "approval-required" | undefined;
  readonly binaryPath?: string | undefined;
  readonly input: string;
  readonly resumeSessionId?: string | undefined;
}

export interface ClaudeAgentManagerSendTurnInput {
  readonly threadId: ThreadId;
  readonly input: string;
  readonly model?: string | undefined;
}

export interface ClaudeAgentManagerTurnStartResult {
  readonly threadId: ThreadId;
  readonly turnId: string;
  readonly resumeCursor?: { sessionId: string };
}

const PROVIDER: ProviderKind = "claude-code";

// ── Manager ──────────────────────────────────────────────────────────

export class ClaudeAgentManager extends EventEmitter {
  private sessions = new Map<string, ClaudeSessionContext>();

  async startSession(
    input: ClaudeAgentManagerStartSessionInput,
  ): Promise<ClaudeAgentManagerTurnStartResult> {
    const threadId = input.threadId;
    const now = new Date().toISOString();
    const turnId = randomUUID();

    const session: ProviderSession = {
      provider: PROVIDER,
      status: "connecting",
      runtimeMode: input.runtimeMode ?? "full-access",
      cwd: input.cwd,
      model: input.model,
      threadId,
      activeTurnId: turnId as TurnId,
      createdAt: now,
      updatedAt: now,
    };

    const context: ClaudeSessionContext = {
      session,
      sessionId: input.resumeSessionId ?? null,
      abortController: new AbortController(),
      pendingApprovals: new Map(),
      pendingUserInputs: new Map(),
      activeToolCalls: new Map(),
      activeTurnId: turnId,
      stopping: false,
    };

    this.sessions.set(threadId, context);
    this.emitLifecycleEvent(context, "session/started", "Claude Code session started.");

    // Only run a query if there's actual input; otherwise just mark session ready
    if (input.input.trim().length > 0) {
      this.runQuery(context, input.input, input).catch((error) => {
        if (!context.stopping) {
          const message =
            error instanceof Error ? error.message : "Unknown error running Claude query.";
          this.updateSession(context, { status: "error", lastError: message });
          this.emitErrorEvent(context, "process/error", message);
        }
      });
    } else {
      this.updateSession(context, { status: "ready", activeTurnId: undefined });
    }

    return {
      threadId,
      turnId,
      ...(context.sessionId ? { resumeCursor: { sessionId: context.sessionId } } : {}),
    };
  }

  async sendTurn(
    input: ClaudeAgentManagerSendTurnInput,
  ): Promise<ClaudeAgentManagerTurnStartResult> {
    const context = this.requireSession(input.threadId);

    if (input.input.trim().length === 0) {
      throw new Error("Cannot send an empty turn to Claude Code.");
    }

    const turnId = randomUUID();
    context.activeTurnId = turnId;

    this.updateSession(context, { status: "running", activeTurnId: turnId as TurnId });

    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "notification",
      provider: PROVIDER,
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method: "turn/started",
      turnId: turnId as TurnId,
    });

    // Run a new query with resume to continue the conversation
    this.runQuery(context, input.input, {
      model: input.model,
      cwd: context.session.cwd,
      runtimeMode: context.session.runtimeMode,
    }).catch((error) => {
      if (!context.stopping) {
        const message = error instanceof Error ? error.message : "Unknown error.";
        this.updateSession(context, { status: "error", lastError: message });
        this.emitErrorEvent(context, "process/error", message);
      }
    });

    return {
      threadId: input.threadId,
      turnId,
      ...(context.sessionId ? { resumeCursor: { sessionId: context.sessionId } } : {}),
    };
  }

  async interruptTurn(threadId: ThreadId): Promise<void> {
    const context = this.requireSession(threadId);
    context.abortController.abort();
    // Create a new AbortController for future queries
    context.abortController = new AbortController();
    this.updateSession(context, { status: "ready", activeTurnId: undefined });
    this.emitLifecycleEvent(context, "turn/interrupted", "Turn interrupted by user.");
  }

  async respondToRequest(
    threadId: ThreadId,
    requestId: string,
    decision: ProviderApprovalDecision,
  ): Promise<void> {
    const context = this.requireSession(threadId);
    const pending = context.pendingApprovals.get(requestId);
    if (!pending) {
      throw new Error(`Unknown pending permission request: ${requestId}`);
    }

    context.pendingApprovals.delete(requestId);

    if (decision === "accept" || decision === "acceptForSession") {
      pending.resolve({ behavior: "allow" });
    } else {
      pending.resolve({ behavior: "deny", message: "Denied by user." });
    }

    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "notification",
      provider: PROVIDER,
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method: "request/resolved",
      requestId: requestId as ApprovalRequestId,
      payload: { decision },
    });
  }

  async respondToUserInput(
    threadId: ThreadId,
    requestId: string,
    answers: ProviderUserInputAnswers,
  ): Promise<void> {
    const context = this.requireSession(threadId);
    const pending = context.pendingUserInputs.get(requestId);
    if (!pending) {
      throw new Error(`Unknown pending user input request: ${requestId}`);
    }

    context.pendingUserInputs.delete(requestId);
    pending.resolve(answers);

    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "notification",
      provider: PROVIDER,
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method: "user-input/resolved",
      requestId: requestId as ApprovalRequestId,
      payload: { answers },
    });
  }

  async stopSession(threadId: ThreadId): Promise<void> {
    const context = this.sessions.get(threadId);
    if (!context) return;

    context.stopping = true;
    context.abortController.abort();

    // Reject all pending approvals
    for (const pending of context.pendingApprovals.values()) {
      pending.resolve({ behavior: "deny", message: "Session stopped." });
    }
    context.pendingApprovals.clear();

    // Reject all pending user inputs
    for (const pending of context.pendingUserInputs.values()) {
      pending.resolve({});
    }
    context.pendingUserInputs.clear();

    this.updateSession(context, { status: "closed" });
    this.emitLifecycleEvent(context, "session/exited", "Claude Code session stopped.");
    this.sessions.delete(threadId);
  }

  async stopAll(): Promise<void> {
    const threadIds = Array.from(this.sessions.keys());
    await Promise.allSettled(threadIds.map((threadId) => this.stopSession(threadId as ThreadId)));
  }

  listSessions(): ProviderSession[] {
    return Array.from(this.sessions.values()).map((context) => ({ ...context.session }));
  }

  hasSession(threadId: ThreadId): boolean {
    return this.sessions.has(threadId);
  }

  getSession(threadId: ThreadId): ProviderSession | undefined {
    return this.sessions.get(threadId)?.session;
  }

  // ── Private ──────────────────────────────────────────────────────

  private requireSession(threadId: ThreadId): ClaudeSessionContext {
    const context = this.sessions.get(threadId);
    if (!context) {
      throw new Error(`Unknown provider session: ${threadId}`);
    }
    if (context.session.status === "closed") {
      throw new Error(`Session is closed: ${threadId}`);
    }
    return context;
  }

  private async runQuery(
    context: ClaudeSessionContext,
    prompt: string,
    options: {
      readonly cwd?: string | undefined;
      readonly model?: string | undefined;
      readonly runtimeMode?: string | undefined;
      readonly binaryPath?: string | undefined;
    },
  ): Promise<void> {
    // Dynamically import the SDK to avoid startup failures if not installed
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    const { query } = sdk;

    const isFullAccess = options.runtimeMode !== "approval-required";
    const permissionMode = isFullAccess ? "bypassPermissions" : "default";

    this.updateSession(context, { status: "running" });

    const queryOptions: Record<string, unknown> = {
      permissionMode,
      ...(isFullAccess ? { allowDangerouslySkipPermissions: true } : {}),
      abortController: context.abortController,
      includePartialMessages: true,
      stderr: (data: string) => {
        console.error(`[claude-code][${context.session.threadId}] ${data}`);
      },
    };

    if (options.model) {
      queryOptions.model = options.model;
    }
    if (options.cwd) {
      queryOptions.cwd = options.cwd;
    }
    if (options.binaryPath) {
      queryOptions.pathToClaudeCodeExecutable = options.binaryPath;
    }
    if (context.sessionId) {
      queryOptions.resume = context.sessionId;
    }

    let turnCompleted = false;
    try {
      const messageStream = query({
        prompt,
        options: queryOptions,
      });

      for await (const message of messageStream) {
        if (context.stopping) break;
        this.handleSdkMessage(context, message);
      }

      if (!context.stopping) {
        turnCompleted = true;
        this.updateSession(context, {
          status: "ready",
          activeTurnId: undefined,
        });
        this.emitEvent({
          id: EventId.makeUnsafe(randomUUID()),
          kind: "notification",
          provider: PROVIDER,
          threadId: context.session.threadId,
          createdAt: new Date().toISOString(),
          method: "turn/completed",
          turnId: context.activeTurnId as TurnId | undefined,
          payload: { status: "completed" },
        });
      }
    } catch (error) {
      if (context.stopping) return;

      const isAborted =
        error instanceof Error &&
        (error.name === "AbortError" || error.message.includes("aborted"));

      if (isAborted) {
        this.updateSession(context, { status: "ready", activeTurnId: undefined });
        this.emitEvent({
          id: EventId.makeUnsafe(randomUUID()),
          kind: "notification",
          provider: PROVIDER,
          threadId: context.session.threadId,
          createdAt: new Date().toISOString(),
          method: "turn/completed",
          turnId: context.activeTurnId as TurnId | undefined,
          payload: { status: "interrupted" },
        });
        return;
      }

      if (!turnCompleted) {
        const message = error instanceof Error ? error.message : "Unknown error.";
        this.updateSession(context, { status: "error", lastError: message });
        this.emitEvent({
          id: EventId.makeUnsafe(randomUUID()),
          kind: "notification",
          provider: PROVIDER,
          threadId: context.session.threadId,
          createdAt: new Date().toISOString(),
          method: "turn/completed",
          turnId: context.activeTurnId as TurnId | undefined,
          payload: { status: "failed", error: message },
        });
      }
    }
  }

  private handleSdkMessage(context: ClaudeSessionContext, message: unknown): void {
    const msg = message as Record<string, unknown>;
    const type = msg.type as string | undefined;
    const subtype = msg.subtype as string | undefined;

    // Always capture session_id from any message that has one
    const msgSessionId = msg.session_id as string | undefined;
    if (msgSessionId && !context.sessionId) {
      context.sessionId = msgSessionId;
    }

    switch (type) {
      case "system": {
        if (subtype === "init") {
          if (msgSessionId) {
            this.updateSession(context, {
              resumeCursor: { sessionId: msgSessionId },
            });
          }
          this.emitLifecycleEvent(context, "session/configured", "Claude Code session configured.");
        }
        break;
      }

      case "stream_event": {
        // SDKPartialAssistantMessage — streaming text deltas
        const event = msg.event as Record<string, unknown> | undefined;
        if (!event) break;
        const eventType = event.type as string | undefined;

        if (eventType === "content_block_delta") {
          const delta = event.delta as Record<string, unknown> | undefined;
          if (delta?.type === "text_delta") {
            const text = delta.text as string | undefined;
            if (text) {
              this.emitEvent({
                id: EventId.makeUnsafe(randomUUID()),
                kind: "notification",
                provider: PROVIDER,
                threadId: context.session.threadId,
                createdAt: new Date().toISOString(),
                method: "item/agentMessage/delta",
                turnId: context.activeTurnId as TurnId | undefined,
                textDelta: text,
              });
            }
          }
        }
        break;
      }

      case "assistant": {
        // Complete assistant message — extract tool use blocks.
        // A new assistant message means all previously active tools have completed.
        this.completeActiveToolCalls(context);

        const contentMessage = msg.message as Record<string, unknown> | undefined;
        const content = contentMessage?.content as unknown[] | undefined;
        if (!content) break;

        for (const block of content) {
          const blockObj = block as Record<string, unknown>;
          if (blockObj.type === "tool_use") {
            const toolName = blockObj.name as string;
            const toolId = (blockObj.id as string) ?? randomUUID();
            context.activeToolCalls.set(toolId, {
              toolName,
              startedAt: new Date().toISOString(),
            });
            this.emitEvent({
              id: EventId.makeUnsafe(randomUUID()),
              kind: "notification",
              provider: PROVIDER,
              threadId: context.session.threadId,
              createdAt: new Date().toISOString(),
              method: "item/tool/started",
              turnId: context.activeTurnId as TurnId | undefined,
              payload: {
                toolName,
                toolId,
                input: blockObj.input,
              },
            });
          }
        }
        break;
      }

      case "result": {
        // Turn is finishing — complete any remaining active tool calls.
        this.completeActiveToolCalls(context);
        break;
      }

      case "tool_progress": {
        this.emitEvent({
          id: EventId.makeUnsafe(randomUUID()),
          kind: "notification",
          provider: PROVIDER,
          threadId: context.session.threadId,
          createdAt: new Date().toISOString(),
          method: "tool/progress",
          turnId: context.activeTurnId as TurnId | undefined,
          payload: {
            toolName: msg.tool_name,
            summary: `${msg.tool_name} (${msg.elapsed_time_seconds}s)`,
          },
        });
        break;
      }

      case "auth_status": {
        // SDKAuthStatusMessage — auth flow during startup
        if (msg.error) {
          this.emitErrorEvent(
            context,
            "auth/error",
            `Authentication error: ${msg.error as string}`,
          );
        }
        break;
      }

      default:
        // Emit unknown messages as generic notifications for debugging
        if (type) {
          this.emitEvent({
            id: EventId.makeUnsafe(randomUUID()),
            kind: "notification",
            provider: PROVIDER,
            threadId: context.session.threadId,
            createdAt: new Date().toISOString(),
            method: `sdk/${type}${subtype ? `/${subtype}` : ""}`,
            turnId: context.activeTurnId as TurnId | undefined,
            payload: msg,
          });
        }
        break;
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────

  private completeActiveToolCalls(context: ClaudeSessionContext): void {
    for (const [toolId, { toolName }] of context.activeToolCalls) {
      this.emitEvent({
        id: EventId.makeUnsafe(randomUUID()),
        kind: "notification",
        provider: PROVIDER,
        threadId: context.session.threadId,
        createdAt: new Date().toISOString(),
        method: "item/tool/completed",
        turnId: context.activeTurnId as TurnId | undefined,
        payload: {
          toolName,
          toolId,
        },
      });
    }
    context.activeToolCalls.clear();
  }

  private updateSession(
    context: ClaudeSessionContext,
    patch: Partial<ProviderSession> & { resumeCursor?: unknown },
  ): void {
    const now = new Date().toISOString();
    context.session = {
      ...context.session,
      ...patch,
      updatedAt: now,
    } as ProviderSession;

    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "session",
      provider: PROVIDER,
      threadId: context.session.threadId,
      createdAt: now,
      method: "session/updated",
      payload: context.session,
    });
  }

  private emitLifecycleEvent(
    context: ClaudeSessionContext,
    method: string,
    message: string,
  ): void {
    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "session",
      provider: PROVIDER,
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method,
      message,
    });
  }

  private emitErrorEvent(context: ClaudeSessionContext, method: string, message: string): void {
    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "error",
      provider: PROVIDER,
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method,
      message,
    });
  }

  private emitEvent(event: Partial<ProviderEvent> & { id: string; kind: string }): void {
    this.emit("event", event);
  }
}
