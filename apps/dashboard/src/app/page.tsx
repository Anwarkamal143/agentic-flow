import type { JobSummary } from '@factory/domain';
import Link from 'next/link';
import { connection } from 'next/server';
import { LiveRefresh } from '@/components/live';
import { RuntimeUnavailableNotice } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatTime, humanize, stateVariant } from '@/lib/format';
import { listJobs, RuntimeUnavailable } from '@/lib/runtime';

export default async function JobsPage() {
  await connection();
  let jobs: JobSummary[];
  try {
    jobs = await listJobs();
  } catch (err) {
    if (err instanceof RuntimeUnavailable)
      return <RuntimeUnavailableNotice message={err.message} />;
    throw err;
  }
  // Newest first.
  const sorted = [...jobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">Jobs</h1>
        <LiveRefresh />
      </div>
      {sorted.length === 0 ? (
        <p className="rounded-xl border p-5 text-sm text-muted-foreground">
          No Jobs yet. Create one with <code>factory job create --repo &lt;id&gt; --title …</code>
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Title</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Stage</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Id</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((job) => (
              <TableRow key={job.id}>
                <TableCell>
                  <Link
                    href={`/jobs/${job.id}`}
                    className="font-medium underline-offset-4 hover:underline"
                  >
                    {job.title}
                  </Link>
                </TableCell>
                <TableCell>
                  <Badge variant={stateVariant(job.status)}>{humanize(job.status)}</Badge>
                </TableCell>
                <TableCell>{job.currentStage}</TableCell>
                <TableCell className="whitespace-nowrap">{formatTime(job.createdAt)}</TableCell>
                <TableCell className="font-mono text-xs">{job.id}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
