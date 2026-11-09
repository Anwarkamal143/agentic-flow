'use client';

export default function ErrorPage({ error }: { error: Error & { digest?: string } }) {
  return (
    <div role="alert" className="rounded-xl border p-5">
      <h1 className="font-semibold">This page could not be rendered</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        The runtime&apos;s answer could not be shown
        {error.digest === undefined ? '.' : ` (error ${error.digest}; see the dashboard's log).`}
      </p>
    </div>
  );
}
