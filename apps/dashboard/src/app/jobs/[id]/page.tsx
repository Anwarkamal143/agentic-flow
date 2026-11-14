import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { AcceptanceCriteria, JobOverview, StageRuns, Tasks } from '@/components/job-sections';
import { JobTimeline } from '@/components/live';
import { PlanViewCard } from '@/components/plan-view';
import { RuntimeUnavailableNotice } from '@/components/states';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { PlanView } from '@factory/domain';
import {
  jobDetail,
  planView,
  RuntimeApiError,
  RuntimeUnavailable,
  type JobDetail,
} from '@/lib/runtime';

export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  let detail: JobDetail;
  let plan: PlanView | null;
  try {
    detail = await jobDetail(id);
    plan = await planView(id);
  } catch (err) {
    if (err instanceof RuntimeApiError && err.status === 404) notFound();
    if (err instanceof RuntimeUnavailable)
      return <RuntimeUnavailableNotice message={err.message} />;
    throw err;
  }
  const { job, criteria, tasks, attempts, reviews, events } = detail;

  return (
    <div className="space-y-6">
      <JobOverview job={job} />
      <StageRuns job={job} />
      <AcceptanceCriteria criteria={criteria} />
      {plan === null ? (
        <Card data-testid="plan" id="plan">
          <CardHeader>
            <CardTitle>Plan</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              No Plan yet: planning hasn’t produced one.
            </p>
          </CardContent>
        </Card>
      ) : (
        <PlanViewCard plan={plan} />
      )}
      <Tasks tasks={tasks} attempts={attempts} reviews={reviews} />
      <Card>
        <CardHeader>
          <CardTitle>Timeline</CardTitle>
        </CardHeader>
        <CardContent>
          <JobTimeline jobId={job.id} events={events} />
        </CardContent>
      </Card>
    </div>
  );
}
