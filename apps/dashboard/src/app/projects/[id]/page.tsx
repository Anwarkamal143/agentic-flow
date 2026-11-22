import type { EffectiveConfigPreview, ProjectDetail } from '@factory/domain';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { EffectiveConfigCard, PreviewNote } from '@/components/effective-config';
import { Field, State } from '@/components/job-sections';
import { RuntimeUnavailableNotice } from '@/components/states';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { formatTime } from '@/lib/format';
import {
  projectConfigPreview,
  projectDetail,
  RuntimeApiError,
  RuntimeUnavailable,
} from '@/lib/runtime';

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  let project: ProjectDetail;
  let preview: EffectiveConfigPreview;
  try {
    // The Project first: an unknown id is a 404 before anything else is asked.
    project = await projectDetail(id);
    preview = await projectConfigPreview(project.id);
  } catch (err) {
    if (err instanceof RuntimeApiError && err.status === 404) notFound();
    if (err instanceof RuntimeUnavailable)
      return <RuntimeUnavailableNotice message={err.message} />;
    throw err;
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-xl">Project {project.name}</CardTitle>
          <CardDescription className="font-mono text-xs">{project.id}</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-4 md:grid-cols-3">
            <Field label="Repositories">
              <span className="flex flex-wrap gap-x-2">
                {project.repositories.length === 0
                  ? 'none yet'
                  : project.repositories.map((r) => (
                      <Link
                        key={r.id}
                        href={`/repositories/${r.id}`}
                        title={r.id}
                        className="font-mono text-xs underline-offset-4 hover:underline"
                      >
                        {r.name}
                      </Link>
                    ))}
              </span>
            </Field>
            <Field label="Created">{formatTime(project.createdAt)}</Field>
          </dl>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Active Jobs</CardTitle>
        </CardHeader>
        <CardContent>
          {project.activeJobs.length === 0 ? (
            <p className="text-sm text-muted-foreground">No active Jobs.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {project.activeJobs.map((j) => (
                <li key={j.id} className="flex items-center gap-2">
                  <Link href={`/jobs/${j.id}`} className="underline-offset-4 hover:underline">
                    {j.title}
                  </Link>
                  <State value={j.status} />
                </li>
              ))}
            </ul>
          )}
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
