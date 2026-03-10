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

vi.mock("@anthropic-ai/claude-agent-sdk", () => {
  const queryFn = vi.fn((args: { prompt: string; options?: Record<string, unknown> }) => {
    lastQueryArgs = { prompt: args.prompt, options: args.options ?? {} };
    const msgs = sdkMessages;
    return (async function* () {
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
): Promise<void> {
  await manager.startSession({
    threadId: asThreadId("thread-1"),
    input,
    cwd: "/tmp",
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

// ── Tests ─────────────────────────────────────────────────────────────

beforeEach(() => {
  sdkMessages = [];
  lastQueryArgs = null;
  sdkQuerySpy?.mockClear();
});

describe("ClaudeAgentManager SDK query options", () => {
  it("passes settingSources to the SDK so skills and project config are loaded", async () => {
    sdkMessages = [
      { type: "system", subtype: "init", session_id: "sess-1" },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "",
        session_id: "sess-1",
      },
    ];

    const manager = new ClaudeAgentManager();
    const events = captureEvents(manager);

    await startAndWait(manager, events);

    // Verify settingSources was passed to load skills
    expect(lastQueryArgs).not.toBeNull();
    expect(lastQueryArgs!.options.settingSources).toEqual(["user", "project"]);

    manager.stopAll();
  });
});
