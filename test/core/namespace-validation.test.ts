import { describe, expect, it } from "vitest";
import { validateProject } from "../../src/core/validation.js";
import { makeIssue, makePhase, makeRoadmap, makeState, makeTicket } from "./test-factories.js";

describe("namespace validation", () => {
  it("warns on cross-namespace blockers and related tickets", () => {
    const state = makeState({
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
      tickets: [
        makeTicket({ id: "DEV01-T-001", blockedBy: ["QA999-T-001"] }),
        makeTicket({ id: "QA999-T-001" }),
      ],
      issues: [
        makeIssue({ id: "DEV01-ISS-001", relatedTickets: ["QA999-T-001"] }),
      ],
    });

    const result = validateProject(state);

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "warning",
          code: "cross_namespace_blocked_by",
          entity: "DEV01-T-001",
        }),
        expect.objectContaining({
          level: "warning",
          code: "cross_namespace_related_ticket",
          entity: "DEV01-ISS-001",
        }),
      ]),
    );
  });

  it("errors on cross-namespace parent tickets", () => {
    const state = makeState({
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
      tickets: [
        makeTicket({ id: "DEV01-T-001" }),
        makeTicket({ id: "QA999-T-001", parentTicket: "DEV01-T-001" }),
      ],
    });

    const result = validateProject(state);

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "error",
          code: "cross_namespace_parent",
          entity: "QA999-T-001",
        }),
      ]),
    );
  });
});
