import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { AcceptanceCriteria, JobOverview, StageRuns, Tasks } from '@/components/job-sections';
import { JobTimeline } from '@/components/live';
import { RuntimeUnavailableNotice } from '@/components/states';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { jobDetail, RuntimeApiError, RuntimeUnavailable, type JobDetail } from '@/lib/runtime';

export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  let detail: JobDetail;
  try {
    detail = await jobDetail(id);
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
