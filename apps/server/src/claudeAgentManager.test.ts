import { randomUUID } from "node:crypto";
import { describe, expect, it, vi, beforeEach, type Mock } from "vitest";
import { ThreadId } from "@t3tools/contracts";

import { ClaudeAgentManager } from "./claudeAgentManager";

const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);

// ── SDK mock ──────────────────────────────────────────────────────────

/** Messages the mock SDK query will yield. Set per-test before calling startSession. */
let sdkMessages: Array<Record<string, unknown>> = [];
let sdkQuerySpy: Mock;
/** Captures the most recent query() call args for assertion. */
let lastQueryArgs: { prompt: string; options: Record<string, unknown> } | null = null;
/** Captures the canUseTool callback from the most recent query() call. */
let capturedCanUseTool: Function | null = null;
/** Tool calls to invoke via canUseTool before yielding messages. */
let sdkToolCalls: Array<{
  toolName: string;
  input: Record<string, unknown>;
  toolUseID?: string;
}> = [];
/** Results returned by canUseTool invocations. */
let canUseToolResults: Array<unknown> = [];

vi.mock("@anthropic-ai/claude-agent-sdk", () => {
  const queryFn = vi.fn((args: { prompt: string; options?: Record<string, unknown> }) => {
    lastQueryArgs = { prompt: args.prompt, options: args.options ?? {} };
    capturedCanUseTool = (args.options?.canUseTool as Function) ?? null;
    const msgs = sdkMessages;
    const toolCalls = [...sdkToolCalls];
    canUseToolResults = [];
    return (async function* () {
      if (capturedCanUseTool && toolCalls.length > 0) {
        for (const call of toolCalls) {
          const result = await capturedCanUseTool(call.toolName, call.input, {
            signal: new AbortController().signal,
            toolUseID: call.toolUseID ?? randomUUID(),
          });
          canUseToolResults.push(result);
        }
      }
      for (const msg of msgs) {
        yield msg;
      }
    })();
  });
  sdkQuerySpy = queryFn;
  return { query: queryFn };
});

// ── Helpers ───────────────────────────────────────────────────────────

interface CapturedEvent {
  method?: string;
  kind?: string;
  message?: string;
  textDelta?: string;
  payload?: Record<string, unknown>;
  turnId?: string;
  requestId?: string;
}

function captureEvents(manager: ClaudeAgentManager): CapturedEvent[] {
  const events: CapturedEvent[] = [];
  manager.on("event", (event: CapturedEvent) => events.push(event));
  return events;
}

/** Start a session and wait for the query to finish (turn/completed or error). */
async function startAndWait(
  manager: ClaudeAgentManager,
  events: CapturedEvent[],
  input = "Hello",
  options?: {
    runtimeMode?: "full-access" | "approval-required";
  },
): Promise<void> {
  await manager.startSession({
    threadId: asThreadId("thread-1"),
    input,
    cwd: "/tmp",
    runtimeMode: options?.runtimeMode,
  });

  // Wait for turn/completed event (the query runs async in the background)
  await vi.waitFor(
    () => {
      const completed = events.find(
        (e) => e.method === "turn/completed" || e.method === "process/error",
      );
      expect(completed).toBeDefined();
    },
    { timeout: 2_000, interval: 50 },
  );
}

const BASIC_SDK_MESSAGES = [
  { type: "system", subtype: "init", session_id: "sess-1" },
  {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "",
    session_id: "sess-1",
  },
];

// ── Tests ─────────────────────────────────────────────────────────────

beforeEach(() => {
  sdkMessages = [];
  sdkToolCalls = [];
  lastQueryArgs = null;
  capturedCanUseTool = null;
  canUseToolResults = [];
  sdkQuerySpy?.mockClear();
});

describe("ClaudeAgentManager SDK query options", () => {
  it("passes settingSources to the SDK so skills and project config are loaded", async () => {
    sdkMessages = BASIC_SDK_MESSAGES;

    const manager = new ClaudeAgentManager();
    const events = captureEvents(manager);

    await startAndWait(manager, events);

    // Verify settingSources was passed to load skills
    expect(lastQueryArgs).not.toBeNull();
    expect(lastQueryArgs!.options.settingSources).toEqual(["user", "project"]);

    manager.stopAll();
  });

  it("uses permissionMode 'default' instead of 'bypassPermissions' in full-access mode", async () => {
    sdkMessages = BASIC_SDK_MESSAGES;

    const manager = new ClaudeAgentManager();
    const events = captureEvents(manager);

    await startAndWait(manager, events);

    expect(lastQueryArgs).not.toBeNull();
    expect(lastQueryArgs!.options.permissionMode).toBe("default");
    expect(lastQueryArgs!.options).not.toHaveProperty("allowDangerouslySkipPermissions");

    manager.stopAll();
  });

  it("uses permissionMode 'plan' when interactionMode is plan", async () => {
    sdkMessages = BASIC_SDK_MESSAGES;

    const manager = new ClaudeAgentManager();
    const events = captureEvents(manager);

    // Start session first
    await startAndWait(manager, events);

    // Now send a turn with plan mode
    sdkMessages = BASIC_SDK_MESSAGES;
    const turnEvents: CapturedEvent[] = [];
    manager.on("event", (event: CapturedEvent) => turnEvents.push(event));

    await manager.sendTurn({
      threadId: asThreadId("thread-1"),
      input: "Plan this feature",
      interactionMode: "plan",
    });

    await vi.waitFor(
      () => {
        const completed = turnEvents.find(
          (e) => e.method === "turn/completed" || e.method === "process/error",
        );
        expect(completed).toBeDefined();
      },
      { timeout: 2_000, interval: 50 },
    );

    // The second query should have used plan mode
    expect(lastQueryArgs).not.toBeNull();
    expect(lastQueryArgs!.options.permissionMode).toBe("plan");

    manager.stopAll();
  });
});

describe("ClaudeAgentManager canUseTool callback", () => {
  it("auto-allows non-AskUserQuestion tools in full-access mode", async () => {
    sdkMessages = BASIC_SDK_MESSAGES;
    sdkToolCalls = [
      { toolName: "Bash", input: { command: "ls" }, toolUseID: "tool-bash-1" },
      { toolName: "Read", input: { file_path: "/tmp/foo" }, toolUseID: "tool-read-1" },
      { toolName: "Edit", input: { file_path: "/tmp/foo", old_string: "a", new_string: "b" }, toolUseID: "tool-edit-1" },
    ];

    const manager = new ClaudeAgentManager();
    const events = captureEvents(manager);

    await startAndWait(manager, events);

    // All three tools should have been auto-allowed
    expect(canUseToolResults).toHaveLength(3);
    for (const result of canUseToolResults) {
      expect(result).toMatchObject({ behavior: "allow" });
    }

    manager.stopAll();
  });

  it("intercepts AskUserQuestion and emits user-input/requested", async () => {
    sdkMessages = BASIC_SDK_MESSAGES;
    const askUserInput = {
      questions: [
        {
          question: "Which approach should we use?",
          header: "Approach",
          multiSelect: false,
          options: [
            { label: "Option A", description: "Use approach A" },
            { label: "Option B", description: "Use approach B" },
          ],
        },
      ],
    };
    sdkToolCalls = [
      { toolName: "AskUserQuestion", input: askUserInput, toolUseID: "tool-ask-1" },
    ];

    const manager = new ClaudeAgentManager();
    const events = captureEvents(manager);

    // Start session — canUseTool will block waiting for user input
    manager.startSession({
      threadId: asThreadId("thread-1"),
      input: "Hello",
      cwd: "/tmp",
    });

    // Wait for user-input/requested event
    await vi.waitFor(
      () => {
        const event = events.find((e) => e.method === "user-input/requested");
        expect(event).toBeDefined();
      },
      { timeout: 2_000, interval: 50 },
    );

    const requestEvent = events.find((e) => e.method === "user-input/requested")!;
    expect(requestEvent.payload).toBeDefined();
    const questions = (requestEvent.payload as Record<string, unknown>).questions as Array<unknown>;
    expect(questions).toHaveLength(1);
    const q = questions[0] as Record<string, unknown>;
    expect(q.question).toBe("Which approach should we use?");
    expect(q.header).toBe("Approach");

    // Respond to the user input
    const requestId = requestEvent.requestId!;
    await manager.respondToUserInput(
      asThreadId("thread-1"),
      requestId,
      { "Which approach should we use?": "Option A" },
    );

    // Wait for turn to complete
    await vi.waitFor(
      () => {
        const completed = events.find((e) => e.method === "turn/completed");
        expect(completed).toBeDefined();
      },
      { timeout: 2_000, interval: 50 },
    );

    // canUseTool should have returned deny with the user's answer formatted as a message
    expect(canUseToolResults).toHaveLength(1);
    const result = canUseToolResults[0] as { behavior: string; message?: string };
    expect(result.behavior).toBe("deny");
    expect(result.message).toContain("Which approach should we use?");
    expect(result.message).toContain("Option A");

    manager.stopAll();
  });

  it("emits request/opened in approval-required mode for non-AskUserQuestion tools", async () => {
    sdkMessages = BASIC_SDK_MESSAGES;
    sdkToolCalls = [
      { toolName: "Bash", input: { command: "rm -rf /" }, toolUseID: "tool-bash-1" },
    ];

    const manager = new ClaudeAgentManager();
    const events = captureEvents(manager);

    // Start session in approval-required mode
    manager.startSession({
      threadId: asThreadId("thread-1"),
      input: "Hello",
      cwd: "/tmp",
      runtimeMode: "approval-required",
    });

    // Wait for request/opened event
    await vi.waitFor(
      () => {
        const event = events.find((e) => e.method === "request/opened");
        expect(event).toBeDefined();
      },
      { timeout: 2_000, interval: 50 },
    );

    const requestEvent = events.find((e) => e.method === "request/opened")!;
    expect(requestEvent.payload).toBeDefined();
    const payload = requestEvent.payload as Record<string, unknown>;
    expect(payload.requestType).toBe("command_execution_approval");
    expect(payload.detail).toBe("Bash");

    // Approve the request
    const requestId = requestEvent.requestId!;
    await manager.respondToRequest(
      asThreadId("thread-1"),
      requestId,
      "accept",
    );

    // Wait for turn to complete
    await vi.waitFor(
      () => {
        const completed = events.find((e) => e.method === "turn/completed");
        expect(completed).toBeDefined();
      },
      { timeout: 2_000, interval: 50 },
    );

    // canUseTool should have returned allow
    expect(canUseToolResults).toHaveLength(1);
    expect(canUseToolResults[0]).toMatchObject({ behavior: "allow" });

    manager.stopAll();
  });

  it("returns deny when approval request is declined", async () => {
    sdkMessages = BASIC_SDK_MESSAGES;
    sdkToolCalls = [
      { toolName: "Bash", input: { command: "rm -rf /" }, toolUseID: "tool-bash-1" },
    ];

    const manager = new ClaudeAgentManager();
    const events = captureEvents(manager);

    // Start session in approval-required mode
    manager.startSession({
      threadId: asThreadId("thread-1"),
      input: "Hello",
      cwd: "/tmp",
      runtimeMode: "approval-required",
    });

    // Wait for request/opened event
    await vi.waitFor(
      () => {
        const event = events.find((e) => e.method === "request/opened");
        expect(event).toBeDefined();
      },
      { timeout: 2_000, interval: 50 },
    );

    const requestEvent = events.find((e) => e.method === "request/opened")!;
    const requestId = requestEvent.requestId!;

    // Decline the request
    await manager.respondToRequest(
      asThreadId("thread-1"),
      requestId,
      "decline",
    );

    // Wait for turn to complete
    await vi.waitFor(
      () => {
        const completed = events.find((e) => e.method === "turn/completed");
        expect(completed).toBeDefined();
      },
      { timeout: 2_000, interval: 50 },
    );

    // canUseTool should have returned deny
    expect(canUseToolResults).toHaveLength(1);
    const result = canUseToolResults[0] as { behavior: string; message?: string };
    expect(result.behavior).toBe("deny");
    expect(result.message).toBe("Denied by user.");

    manager.stopAll();
  });
});
