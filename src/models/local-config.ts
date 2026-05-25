import { z } from "zod";

export const NAMESPACE_REGEX = /^[A-Z0-9]{3,12}$/;

export const LocalConfigSchema = z.object({
  namespace: z
    .string()
    .regex(
      NAMESPACE_REGEX,
      "Namespace must be 3-12 uppercase alphanumeric characters",
    ),
});

export type LocalConfig = z.infer<typeof LocalConfigSchema>;
