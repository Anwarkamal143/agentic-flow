/**
 * Immutable, content-addressed Artifacts (ARCHITECTURE §3, §5). A content file
 * is named by the SHA-256 of its bytes, written once (read-only), and checked
 * against its hash on every read. Rows are only inserted, never updated.
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { appendEvent, schema, type FactoryDb, type Tx } from '@factory/db';
import { ArtifactKindSchema, type Artifact, type ArtifactKind } from '@factory/domain';
import { asc, eq, sql } from 'drizzle-orm';
import { ApiFailure } from './errors.js';
import { newId } from './ids.js';

export const ARTIFACT_SCHEMA_VERSION = 1;

/** Content written to disk but not yet recorded. */
export interface StoredContent {
  readonly contentHash: string;
  /** Relative to the factory home. */
  readonly path: string;
}

export class ArtifactStore {
  constructor(
    private readonly db: FactoryDb,
    /** The factory home root; content paths are relative to it. */
    private readonly homeRoot: string,
  ) {}

  /**
   * Writes `value` as canonical JSON under its content hash. Writing the same
   * content again is a no-op; an existing file that no longer matches its
   * name is refused rather than overwritten.
   */
  writeContent(value: unknown): StoredContent {
    const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8');
    const hex = sha256(bytes);
    const path = join('artifacts', 'sha256', hex.slice(0, 2), `${hex}.json`);
    const abs = join(this.homeRoot, path);
    if (existsSync(abs)) {
      this.verify(abs, `sha256:${hex}`);
    } else {
      mkdirSync(dirname(abs), { recursive: true, mode: 0o700 });
      const tmp = `${abs}.${String(process.pid)}.tmp`;
      writeFileSync(tmp, bytes, { mode: 0o400, flag: 'wx' });
      renameSync(tmp, abs);
      chmodSync(abs, 0o400);
    }
    return { contentHash: `sha256:${hex}`, path };
  }

  /** Records stored content as a Job's Artifact, with its event, in the caller's transaction. */
  record(
    tx: Tx,
    input: {
      jobId: string;
      /** For a proposal. */
      stageRunId?: string;
      /** For an Attempt's Artifacts. */
      taskId?: string;
      attemptId?: string;
      kind: ArtifactKind;
      content: StoredContent;
    },
    actor: string,
  ): Artifact {
    const row = {
      id: newId('art'),
      jobId: input.jobId,
      stageRunId: input.stageRunId ?? null,
      taskId: input.taskId ?? null,
      attemptId: input.attemptId ?? null,
      kind: input.kind,
      contentHash: input.content.contentHash,
      path: input.content.path,
      schemaVersion: ARTIFACT_SCHEMA_VERSION,
      createdAt: new Date().toISOString(),
    };
    tx.insert(schema.artifacts).values(row).run();
    appendEvent(tx, {
      entityKind: 'artifact',
      entityId: row.id,
      jobId: input.jobId,
      type: 'artifact.created',
      actor,
      payload: {
        kind: row.kind,
        contentHash: row.contentHash,
        stageRunId: row.stageRunId,
        taskId: row.taskId,
        attemptId: row.attemptId,
      },
    });
    return toArtifact(row);
  }

  listForJob(jobId: string): Artifact[] {
    return this.db
      .select()
      .from(schema.artifacts)
      .where(eq(schema.artifacts.jobId, jobId))
      .orderBy(asc(sql`rowid`))
      .all()
      .map(toArtifact);
  }

  get(id: string): Artifact {
    return toArtifact(this.row(id));
  }

  /** The content bytes, after checking them against the recorded hash. */
  readContent(id: string): Buffer {
    const row = this.row(id);
    return this.verify(join(this.homeRoot, row.path), row.contentHash);
  }

  /** Parsed content of an Artifact. */
  readJson(id: string): unknown {
    return JSON.parse(this.readContent(id).toString('utf8'));
  }

  private row(id: string) {
    const row = this.db.select().from(schema.artifacts).where(eq(schema.artifacts.id, id)).get();
    if (row === undefined) throw new ApiFailure(404, 'artifact_not_found', `no Artifact ${id}`);
    return row;
  }

  private verify(abs: string, contentHash: string): Buffer {
    const bytes = readFileSync(abs);
    if (`sha256:${sha256(bytes)}` !== contentHash) {
      throw new Error(`Artifact content ${abs} does not match its hash ${contentHash}`);
    }
    return bytes;
  }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function toArtifact(row: typeof schema.artifacts.$inferSelect): Artifact {
  return {
    id: row.id,
    jobId: row.jobId,
    stageRunId: row.stageRunId,
    taskId: row.taskId,
    attemptId: row.attemptId,
    kind: ArtifactKindSchema.parse(row.kind),
    contentHash: row.contentHash,
    schemaVersion: row.schemaVersion,
    createdAt: row.createdAt,
  };
}
