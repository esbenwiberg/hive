import { describe, it, expect } from "vitest";
import {
  canTransition,
  getAvailableActions,
  ALLOWED_TRANSITIONS,
} from "../../src/domain/state-machine.js";
import { TaskStatus } from "../../src/domain/types.js";

// ── canTransition ───────────────────────────────────────────────────────────

describe("canTransition", () => {
  it("allows pending -> queued", () => {
    expect(canTransition("pending", "queued")).toBe(true);
  });

  it("allows pending -> cancelled", () => {
    expect(canTransition("pending", "cancelled")).toBe(true);
  });

  it("allows pending -> rejected", () => {
    expect(canTransition("pending", "rejected")).toBe(true);
  });

  it("disallows pending -> executing", () => {
    expect(canTransition("pending", "executing")).toBe(false);
  });

  it("allows queued -> enriching", () => {
    expect(canTransition("queued", "enriching")).toBe(true);
  });

  it("allows enriching -> ready", () => {
    expect(canTransition("enriching", "ready")).toBe(true);
  });

  it("allows ready -> approved", () => {
    expect(canTransition("ready", "approved")).toBe(true);
  });

  it("allows approved -> executing", () => {
    expect(canTransition("approved", "executing")).toBe(true);
  });

  it("allows executing -> reviewing", () => {
    expect(canTransition("executing", "reviewing")).toBe(true);
  });

  it("allows reviewing -> done", () => {
    expect(canTransition("reviewing", "done")).toBe(true);
  });

  it("allows reviewing -> rework", () => {
    expect(canTransition("reviewing", "rework")).toBe(true);
  });

  it("allows done -> merged", () => {
    expect(canTransition("done", "merged")).toBe(true);
  });

  it("disallows merged -> anything", () => {
    expect(canTransition("merged", "pending")).toBe(false);
    expect(canTransition("merged", "done")).toBe(false);
  });

  it("disallows rejected -> anything", () => {
    expect(canTransition("rejected", "pending")).toBe(false);
  });

  it("disallows cancelled -> anything", () => {
    expect(canTransition("cancelled", "pending")).toBe(false);
  });

  it("allows failed -> pending (retry)", () => {
    expect(canTransition("failed", "pending")).toBe(true);
  });

  it("allows rework -> executing", () => {
    expect(canTransition("rework", "executing")).toBe(true);
  });

  it("returns false for unknown status", () => {
    expect(canTransition("nonexistent", "pending")).toBe(false);
  });

  it("covers all TaskStatus values as keys in ALLOWED_TRANSITIONS", () => {
    const allStatuses = Object.values(TaskStatus);
    for (const status of allStatuses) {
      expect(ALLOWED_TRANSITIONS).toHaveProperty(status);
    }
  });
});

// ── getAvailableActions ─────────────────────────────────────────────────────

describe("getAvailableActions", () => {
  it("returns queue, cancel, reject for pending", () => {
    const actions = getAvailableActions("pending");
    expect(actions).toHaveLength(3);

    const actionNames = actions.map((a) => a.action);
    expect(actionNames).toContain("queue");
    expect(actionNames).toContain("cancel");
    expect(actionNames).toContain("reject");
  });

  it("returns approve, reject, cancel for ready", () => {
    const actions = getAvailableActions("ready");
    const actionNames = actions.map((a) => a.action);
    expect(actionNames).toContain("approve");
    expect(actionNames).toContain("reject");
    expect(actionNames).toContain("cancel");
  });

  it("returns complete, rework, fail for reviewing", () => {
    const actions = getAvailableActions("reviewing");
    const actionNames = actions.map((a) => a.action);
    expect(actionNames).toContain("complete");
    expect(actionNames).toContain("rework");
    expect(actionNames).toContain("fail");
  });

  it("returns merge for done", () => {
    const actions = getAvailableActions("done");
    expect(actions).toHaveLength(1);
    expect(actions[0].action).toBe("merge");
    expect(actions[0].targetStatus).toBe("merged");
    expect(actions[0].label).toBe("Merge");
  });

  it("returns retry for failed", () => {
    const actions = getAvailableActions("failed");
    expect(actions).toHaveLength(1);
    expect(actions[0].action).toBe("retry");
    expect(actions[0].targetStatus).toBe("pending");
  });

  it("returns empty array for merged (terminal state)", () => {
    expect(getAvailableActions("merged")).toEqual([]);
  });

  it("returns empty array for rejected (terminal state)", () => {
    expect(getAvailableActions("rejected")).toEqual([]);
  });

  it("returns empty array for cancelled (terminal state)", () => {
    expect(getAvailableActions("cancelled")).toEqual([]);
  });

  it("returns empty array for unknown status", () => {
    expect(getAvailableActions("nonexistent")).toEqual([]);
  });

  it("every action targetStatus is a valid transition", () => {
    for (const status of Object.values(TaskStatus)) {
      const actions = getAvailableActions(status);
      for (const action of actions) {
        expect(
          canTransition(status, action.targetStatus),
          `action "${action.action}" maps ${status} -> ${action.targetStatus} but canTransition returns false`,
        ).toBe(true);
      }
    }
  });
});
