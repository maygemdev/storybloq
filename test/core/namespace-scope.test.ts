import { describe, expect, it } from "vitest";
import {
  namespacesForTargetIds,
  scopeProjectState,
  summarizeNamespaces,
} from "../../src/core/namespace-scope.js";
import { makeIssue, makeNote, makePhase, makeRoadmap, makeState, makeTicket } from "./test-factories.js";

describe("namespace scope", () => {
  it("filters tickets, issues, and namespaced notes while keeping global notes", () => {
    const state = makeState({
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
      tickets: [
        makeTicket({ id: "DEV01-T-001", title: "Dev work" }),
        makeTicket({ id: "QA999-T-001", title: "QA work" }),
      ],
      issues: [
        makeIssue({ id: "DEV01-ISS-001", title: "Dev issue" }),
        makeIssue({ id: "QA999-ISS-001", title: "QA issue" }),
      ],
      notes: [
        makeNote({ id: "N-001", title: "Global" }),
        makeNote({ id: "N-002", title: "Dev", namespace: "DEV01" }),
        makeNote({ id: "N-003", title: "QA", namespace: "QA999" }),
      ],
    });

    const scoped = scopeProjectState(state, { mode: "active", namespace: "DEV01" });

    expect(scoped.tickets.map((ticket) => ticket.id)).toEqual(["DEV01-T-001"]);
    expect(scoped.issues.map((issue) => issue.id)).toEqual(["DEV01-ISS-001"]);
    expect(scoped.notes.map((note) => note.id)).toEqual(["N-001", "N-002"]);
  });

  it("summarizes namespaces from tickets and issues", () => {
    const state = makeState({
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
      tickets: [
        makeTicket({ id: "DEV01-T-001", status: "open" }),
        makeTicket({ id: "DEV01-T-002", status: "inprogress" }),
        makeTicket({ id: "QA999-T-001", status: "complete" }),
      ],
      issues: [
        makeIssue({ id: "DEV01-ISS-001", status: "open" }),
        makeIssue({ id: "QA999-ISS-001", status: "resolved" }),
      ],
    });

    expect(summarizeNamespaces(state)).toEqual([
      {
        namespace: "DEV01",
        tickets: 2,
        openTickets: 2,
        inProgressTickets: 1,
        issues: 1,
        openIssues: 1,
      },
      {
        namespace: "QA999",
        tickets: 1,
        openTickets: 0,
        inProgressTickets: 0,
        issues: 1,
        openIssues: 0,
      },
    ]);
  });

  it("extracts distinct namespaces from target work IDs", () => {
    expect(namespacesForTargetIds(["DEV01-T-001", "DEV01-ISS-001", "QA999-T-001"])).toEqual([
      "DEV01",
      "QA999",
    ]);
  });
});
