import type { EffectiveConfigPreview, Repository } from '@factory/domain';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { EffectiveConfigCard, PreviewNote } from '@/components/effective-config';
import { Field } from '@/components/job-sections';
import { RuntimeUnavailableNotice } from '@/components/states';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { formatTime } from '@/lib/format';
import {
  repositories,
  repositoryConfigPreview,
  RuntimeApiError,
  RuntimeUnavailable,
} from '@/lib/runtime';

export default async function RepositoryPage({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  let preview: EffectiveConfigPreview;
  let repository: Repository | undefined;
  try {
    // The preview first: an unknown id is a 404 before anything else is asked.
    preview = await repositoryConfigPreview(id);
    repository = (await repositories()).find((r) => r.id === id);
  } catch (err) {
    if (err instanceof RuntimeApiError && err.status === 404) notFound();
    if (err instanceof RuntimeUnavailable)
      return <RuntimeUnavailableNotice message={err.message} />;
    throw err;
  }
  if (repository === undefined) notFound();

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-xl">Repository {repository.name}</CardTitle>
          <CardDescription className="font-mono text-xs">{repository.id}</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-4 md:grid-cols-3">
            <Field label="Project">
              <Link
                href={`/projects/${preview.projectId}`}
                className="underline-offset-4 hover:underline"
              >
                {preview.projectName}
              </Link>
            </Field>
            <Field label="Default branch">
              <code className="font-mono text-xs">{repository.defaultBranch}</code>
            </Field>
            <Field label="Source">
              <code className="font-mono text-xs">{repository.source}</code>
            </Field>
            <Field label="Registered">{formatTime(repository.createdAt)}</Field>
          </dl>
        </CardContent>
      </Card>
      <EffectiveConfigCard
        config={preview.config}
        title="Effective configuration (live preview)"
        description={<PreviewNote />}
      />
    </div>
  );
}
