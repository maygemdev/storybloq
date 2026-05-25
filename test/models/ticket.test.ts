import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { fixturesDir, readJson } from "../helpers.js";
import { TicketSchema } from "../../src/models/ticket.js";

describe("TicketSchema", () => {
  describe("valid tickets", () => {
    it("parses a complete ticket with all fields", () => {
      const data = readJson(resolve(fixturesDir, "valid/basic/tickets/TEST-T-001.json"));
      const result = TicketSchema.safeParse(data);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.id).toBe("TEST-T-001");
        expect(result.data.status).toBe("complete");
        expect(result.data.completedDate).toBe("2026-01-02");
        expect(result.data.parentTicket).toBeNull();
      }
    });

    it("parses a ticket with optional fields absent", () => {
      const data = readJson(resolve(fixturesDir, "valid/basic/tickets/TEST-T-002.json"));
      const result = TicketSchema.safeParse(data);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.parentTicket).toBeUndefined();
        expect(result.data.createdBy).toBeUndefined();
      }
    });

    it("parses a suffixed ticket ID (T-005a)", () => {
      const data = readJson(resolve(fixturesDir, "valid/basic/tickets/TEST-T-005a.json"));
      const result = TicketSchema.safeParse(data);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.id).toBe("TEST-T-005a");
      }
    });

    it("parses a chore ticket type", () => {
      const data = readJson(resolve(fixturesDir, "valid/basic/tickets/TEST-T-005a.json"));
      const result = TicketSchema.safeParse(data);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.type).toBe("chore");
      }
    });

    it("parses a ticket with parentTicket set", () => {
      const data = readJson(resolve(fixturesDir, "valid/basic/tickets/TEST-T-004.json"));
      const result = TicketSchema.safeParse(data);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.parentTicket).toBe("TEST-T-003");
      }
    });

    it("parses all valid fixture tickets", () => {
      const ticketFiles = ["TEST-T-001.json", "TEST-T-002.json", "TEST-T-003.json", "TEST-T-004.json", "TEST-T-005a.json"];
      for (const file of ticketFiles) {
        const data = readJson(resolve(fixturesDir, `valid/basic/tickets/${file}`));
        const result = TicketSchema.safeParse(data);
        expect(result.success, `Failed to parse ${file}`).toBe(true);
      }
    });
  });

  describe("invalid tickets", () => {
    it("rejects a ticket with missing id", () => {
      const data = readJson(resolve(fixturesDir, "invalid/missing-id-ticket.json"));
      expect(TicketSchema.safeParse(data).success).toBe(false);
    });

    it("rejects a ticket with invalid status enum", () => {
      const data = readJson(resolve(fixturesDir, "invalid/bad-status-ticket.json"));
      expect(TicketSchema.safeParse(data).success).toBe(false);
    });

    it("rejects a ticket with invalid id format", () => {
      const data = {
        id: "TICKET-001", title: "Bad ID", description: "", type: "task",
        status: "open", phase: null, order: 10, createdDate: "2026-01-01",
        completedDate: null, blockedBy: [],
      };
      expect(TicketSchema.safeParse(data).success).toBe(false);
    });

    it("rejects a ticket with impossible calendar date", () => {
      const data = readJson(resolve(fixturesDir, "invalid/bad-date-ticket.json"));
      expect(TicketSchema.safeParse(data).success).toBe(false);
    });

    it("rejects a ticket with invalid blockedBy ID format", () => {
      const data = readJson(resolve(fixturesDir, "invalid/bad-blockedby-ticket.json"));
      expect(TicketSchema.safeParse(data).success).toBe(false);
    });
  });

  describe("round-trip unknown key preservation", () => {
    it("preserves unknown extra keys through parse and serialize", () => {
      const data = readJson(resolve(fixturesDir, "valid/extra-fields-ticket.json"));
      const result = TicketSchema.safeParse(data);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.customField).toBe("should be preserved");
        expect(result.data.anotherExtra).toBe(42);
        expect(result.data.nestedExtra).toEqual({ key: "value" });

        const serialized = JSON.parse(JSON.stringify(result.data));
        const reparsed = TicketSchema.safeParse(serialized);
        expect(reparsed.success).toBe(true);
        if (reparsed.success) {
          expect(reparsed.data.customField).toBe("should be preserved");
          expect(reparsed.data.anotherExtra).toBe(42);
          expect(reparsed.data.nestedExtra).toEqual({ key: "value" });
        }
      }
    });
  });

  describe("crossNodeBlockedBy (T-337)", () => {
    const validTicket = {
      id: "TEST-T-100", title: "Test", description: "", type: "task",
      status: "open", phase: null, order: 10, createdDate: "2026-01-01",
      completedDate: null, blockedBy: [],
    };

    it("accepts ticket with crossNodeBlockedBy field", () => {
      const data = { ...validTicket, crossNodeBlockedBy: ["engine:TEST-T-061", "cloud:TEST-ISS-005"] };
      const result = TicketSchema.safeParse(data);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.crossNodeBlockedBy).toEqual(["engine:TEST-T-061", "cloud:TEST-ISS-005"]);
      }
    });

    it("accepts ticket without crossNodeBlockedBy (optional)", () => {
      const result = TicketSchema.safeParse(validTicket);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.crossNodeBlockedBy).toBeUndefined();
      }
    });

    it("rejects invalid cross-node ref format (missing node prefix)", () => {
      const data = { ...validTicket, crossNodeBlockedBy: ["TEST-T-061"] };
      const result = TicketSchema.safeParse(data);
      expect(result.success).toBe(false);
    });

    it("rejects uppercase node name in ref", () => {
      const data = { ...validTicket, crossNodeBlockedBy: ["Engine:TEST-T-061"] };
      const result = TicketSchema.safeParse(data);
      expect(result.success).toBe(false);
    });

    it("accepts suffixed ticket ID in ref", () => {
      const data = { ...validTicket, crossNodeBlockedBy: ["engine:TEST-T-012a"] };
      const result = TicketSchema.safeParse(data);
      expect(result.success).toBe(true);
    });

    it("accepts issue ID in ref", () => {
      const data = { ...validTicket, crossNodeBlockedBy: ["cloud:TEST-ISS-042"] };
      const result = TicketSchema.safeParse(data);
      expect(result.success).toBe(true);
    });
  });
});
