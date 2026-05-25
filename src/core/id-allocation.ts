import type { Ticket } from "../models/ticket.js";
import type { Issue } from "../models/issue.js";
import type { Note } from "../models/note.js";
import type { Lesson } from "../models/lesson.js";
import type { ProjectState } from "./project-state.js";
import { TICKET_ID_REGEX, ISSUE_ID_REGEX, NOTE_ID_REGEX, LESSON_ID_REGEX } from "../models/types.js";

const TICKET_NUMERIC_REGEX = /^[A-Z0-9]{3,12}-T-(\d+)[a-z]?$/;
const ISSUE_NUMERIC_REGEX = /^[A-Z0-9]{3,12}-ISS-(\d+)$/;
const NOTE_NUMERIC_REGEX = /^N-(\d+)$/;
const LESSON_NUMERIC_REGEX = /^L-(\d+)$/;

/**
 * Next ticket ID: scan existing IDs within the given namespace, find max numeric
 * part, return {namespace}-T-(max+1). Zero-padded to 3 digits minimum.
 * Handles suffixed IDs (NS-T-077a → numeric 77).
 */
export function nextTicketID(tickets: readonly Ticket[], namespace: string): string {
  let max = 0;
  const prefix = `${namespace}-T-`;
  for (const t of tickets) {
    if (!t.id.startsWith(prefix)) continue;
    if (!TICKET_ID_REGEX.test(t.id)) continue;
    const match = t.id.match(TICKET_NUMERIC_REGEX);
    if (match?.[1]) {
      const num = parseInt(match[1], 10);
      if (num > max) max = num;
    }
  }
  return `${namespace}-T-${String(max + 1).padStart(3, "0")}`;
}

/**
 * Next issue ID: scan existing IDs within the given namespace, find max numeric
 * part, return {namespace}-ISS-(max+1). Zero-padded to 3 digits minimum.
 */
export function nextIssueID(issues: readonly Issue[], namespace: string): string {
  let max = 0;
  const prefix = `${namespace}-ISS-`;
  for (const i of issues) {
    if (!i.id.startsWith(prefix)) continue;
    if (!ISSUE_ID_REGEX.test(i.id)) continue;
    const match = i.id.match(ISSUE_NUMERIC_REGEX);
    if (match?.[1]) {
      const num = parseInt(match[1], 10);
      if (num > max) max = num;
    }
  }
  return `${namespace}-ISS-${String(max + 1).padStart(3, "0")}`;
}

/**
 * Next note ID: scan existing IDs, find max numeric part, return N-(max+1).
 * Zero-padded to 3 digits minimum.
 */
export function nextNoteID(notes: readonly Note[]): string {
  let max = 0;
  for (const n of notes) {
    if (!NOTE_ID_REGEX.test(n.id)) continue;
    const match = n.id.match(NOTE_NUMERIC_REGEX);
    if (match?.[1]) {
      const num = parseInt(match[1], 10);
      if (num > max) max = num;
    }
  }
  return `N-${String(max + 1).padStart(3, "0")}`;
}

/**
 * Next lesson ID: scan existing IDs, find max numeric part, return L-(max+1).
 * Zero-padded to 3 digits minimum.
 */
export function nextLessonID(lessons: readonly Lesson[]): string {
  let max = 0;
  for (const l of lessons) {
    if (!LESSON_ID_REGEX.test(l.id)) continue;
    const match = l.id.match(LESSON_NUMERIC_REGEX);
    if (match?.[1]) {
      const num = parseInt(match[1], 10);
      if (num > max) max = num;
    }
  }
  return `L-${String(max + 1).padStart(3, "0")}`;
}

/**
 * Next order value for a phase: max leaf ticket order + 10, or 10 if empty.
 */
export function nextOrder(
  phaseId: string | null,
  state: ProjectState,
): number {
  const tickets = state.phaseTickets(phaseId);
  if (tickets.length === 0) return 10;
  return tickets[tickets.length - 1]!.order + 10;
}
