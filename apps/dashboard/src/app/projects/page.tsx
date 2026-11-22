import type { ProjectSummary } from '@factory/domain';
import Link from 'next/link';
import { connection } from 'next/server';
import { RuntimeUnavailableNotice } from '@/components/states';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatTime } from '@/lib/format';
import { projectSummaries, RuntimeUnavailable } from '@/lib/runtime';

export default async function ProjectsPage() {
  await connection();
  let projects: ProjectSummary[];
  try {
    projects = await projectSummaries();
  } catch (err) {
    if (err instanceof RuntimeUnavailable)
      return <RuntimeUnavailableNotice message={err.message} />;
    throw err;
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Projects</h1>
      {projects.length === 0 ? (
        <p className="rounded-xl border p-5 text-sm text-muted-foreground">
          No Projects yet. Create one with <code>factory project create &lt;name&gt;</code>
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Repositories</TableHead>
              <TableHead>Active Jobs</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Id</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {projects.map((p) => (
              <TableRow key={p.id}>
                <TableCell>
                  <Link
                    href={`/projects/${p.id}`}
                    className="font-medium underline-offset-4 hover:underline"
                  >
                    {p.name}
                  </Link>
                </TableCell>
                <TableCell>
                  <span className="flex flex-wrap gap-x-2">
                    {p.repositories.map((r) => (
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
                </TableCell>
                <TableCell>{p.activeJobs.length}</TableCell>
                <TableCell className="whitespace-nowrap">{formatTime(p.createdAt)}</TableCell>
                <TableCell className="font-mono text-xs">{p.id}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
