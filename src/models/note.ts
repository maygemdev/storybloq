import { z } from "zod";
import { NAMESPACE_REGEX } from "./local-config.js";
import { NOTE_STATUSES, DateSchema, NoteIdSchema } from "./types.js";

export const NoteSchema = z
  .object({
    id: NoteIdSchema,
    title: z.string().nullable(),
    content: z.string().refine((v) => v.trim().length > 0, "Content cannot be empty"),
    tags: z.array(z.string()),
    status: z.enum(NOTE_STATUSES),
    namespace: z.string().regex(NAMESPACE_REGEX).nullable().optional(),
    createdDate: DateSchema,
    updatedDate: DateSchema,
  })
  .passthrough();

export type Note = z.infer<typeof NoteSchema>;
