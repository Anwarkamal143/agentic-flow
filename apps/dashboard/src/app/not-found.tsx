import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="rounded-xl border p-5">
      <h1 className="font-semibold">Not found</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        The runtime has no such Job.{' '}
        <Link href="/" className="underline">
          All Jobs
        </Link>
      </p>
    </div>
  );
}
