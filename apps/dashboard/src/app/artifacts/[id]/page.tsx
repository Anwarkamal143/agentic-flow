import Link from 'next/link';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { Field } from '@/components/job-sections';
import { RuntimeUnavailableNotice } from '@/components/states';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { formatTime } from '@/lib/format';
import { artifact, RuntimeApiError, RuntimeUnavailable } from '@/lib/runtime';

/**
 * One Artifact, read-only: its record and its stored content as is (an Inbox
 * Item's Evidence links here). Artifacts are immutable and redacted when
 * stored (ADR-0011); agent output in them is a proposal, not a fact.
 */
export default async function ArtifactPage({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  let found: Awaited<ReturnType<typeof artifact>>;
  try {
    found = await artifact(id);
  } catch (err) {
    if (err instanceof RuntimeApiError && err.status === 404) notFound();
    if (err instanceof RuntimeUnavailable)
      return <RuntimeUnavailableNotice message={err.message} />;
    throw err;
  }
  const { artifact: a, content } = found;

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {a.kind} Artifact <span className="font-mono text-sm">{a.id}</span>
        </CardTitle>
        <CardDescription>
          Of Job{' '}
          <Link href={`/jobs/${a.jobId}`} className="font-mono underline underline-offset-4">
            {a.jobId}
          </Link>
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Field label="Kind">{a.kind}</Field>
          <Field label="Schema version">{a.schemaVersion}</Field>
          <Field label="Created">{formatTime(a.createdAt)}</Field>
          <Field label="Content hash">
            <code className="font-mono text-xs break-all">{a.contentHash}</code>
          </Field>
        </dl>
        <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">
          {JSON.stringify(content, null, 2)}
        </pre>
      </CardContent>
    </Card>
  );
}
