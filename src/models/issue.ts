import { z } from "zod";
import {
  ISSUE_STATUSES,
  ISSUE_SEVERITIES,
  DateSchema,
  IssueIdSchema,
  TicketIdSchema,
} from "./types.js";

export const IssueSchema = z
  .object({
    id: IssueIdSchema,
    title: z.string().min(1),
    status: z.enum(ISSUE_STATUSES),
    severity: z.enum(ISSUE_SEVERITIES),
    components: z.array(z.string()),
    impact: z.string(),
    resolution: z.string().nullable(),
    location: z.array(z.string()),
    discoveredDate: DateSchema,
    resolvedDate: DateSchema.nullable(),
    relatedTickets: z.array(TicketIdSchema),
    // Optional fields — older issues may omit these
    order: z.number().int().optional(),
    phase: z.string().nullable().optional(),
    // Attribution fields — unused in v1
    createdBy: z.string().nullable().optional(),
    assignedTo: z.string().nullable().optional(),
    lastModifiedBy: z.string().nullable().optional(),
    // Autonomous session ownership — set when issue is claimed as inprogress.
    claimedBySession: z.string().nullable().optional(),
  })
  .passthrough();

export type Issue = z.infer<typeof IssueSchema>;
