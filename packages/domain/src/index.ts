/**
 * Entities and API contracts shared by the runtime and its clients. Zod schemas
 * only: no I/O (ARCHITECTURE §2).
 */
import { z } from 'zod';

const commandSchema = z.string().trim().min(1).max(1000).nullable();

/** Shell commands the factory runs to verify work in a Repository. `null`: none. */
export const RepositoryCommandsSchema = z.object({
  test: commandSchema,
  typecheck: commandSchema,
});
export type RepositoryCommands = z.infer<typeof RepositoryCommandsSchema>;

export const PackageManagerSchema = z.enum(['npm', 'pnpm', 'yarn', 'bun']);
export type PackageManager = z.infer<typeof PackageManagerSchema>;

/**
 * What the factory knows about how to work in a Repository. Detected commands
 * are proposals until a human confirms them; only confirmed profiles are saved.
 */
export const RepositoryProfileSchema = z.object({
  version: z.literal(1),
  packageManager: PackageManagerSchema.nullable(),
  commands: RepositoryCommandsSchema,
  confirmedBy: z.string(),
  confirmedAt: z.string(),
});
export type RepositoryProfile = z.infer<typeof RepositoryProfileSchema>;

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const RepositorySchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  /** The path given at registration. The factory never writes to it (ADR-0001). */
  source: z.string(),
  /** The source's `origin` URL at registration, when it had one. */
  remoteUrl: z.string().nullable(),
  /** The Factory Clone, under the workspace root. */
  clonePath: z.string(),
  defaultBranch: z.string(),
  profile: RepositoryProfileSchema,
  createdAt: z.string(),
});
export type Repository = z.infer<typeof RepositorySchema>;

const absolutePath = z
  .string()
  .min(1)
  .refine((p) => p.startsWith('/'), 'must be an absolute path');

/** `POST /v1/repositories/inspect`: read-only look at a path before registering it. */
export const InspectRepositoryInputSchema = z.object({ path: absolutePath });
export type InspectRepositoryInput = z.infer<typeof InspectRepositoryInputSchema>;

export const RepositoryInspectionSchema = z.object({
  /** The working tree root of the repository that contains `path`. */
  source: z.string(),
  name: z.string(),
  remoteUrl: z.string().nullable(),
  packageManager: PackageManagerSchema.nullable(),
  /** Proposed commands, for the human to confirm or replace. */
  detectedCommands: RepositoryCommandsSchema,
});
export type RepositoryInspection = z.infer<typeof RepositoryInspectionSchema>;

/** `POST /v1/repositories`. `commands` are the human-confirmed ones. */
export const RegisterRepositoryInputSchema = z.object({
  path: absolutePath,
  project: z.string().trim().min(1).max(100),
  commands: RepositoryCommandsSchema,
});
export type RegisterRepositoryInput = z.infer<typeof RegisterRepositoryInputSchema>;

export const RegisterRepositoryResultSchema = z.object({
  project: ProjectSchema,
  repository: RepositorySchema,
  /** How the Factory Clone was made. */
  cloneMethod: z.enum(['origin_with_reference', 'path']),
});
export type RegisterRepositoryResult = z.infer<typeof RegisterRepositoryResultSchema>;

/** Error body of every non-2xx API response. */
export const ApiErrorSchema = z.object({ error: z.string(), message: z.string().optional() });
export type ApiError = z.infer<typeof ApiErrorSchema>;
