import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/** The runtime could not be reached: say why, and how to fix it. */
export function RuntimeUnavailableNotice({ message }: { message: string }) {
  return (
    <Card role="alert">
      <CardHeader>
        <CardTitle>The factory runtime is unavailable</CardTitle>
        <CardDescription>Nothing can be shown until the dashboard can reach it.</CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-sm">{message}</p>
      </CardContent>
    </Card>
  );
}
