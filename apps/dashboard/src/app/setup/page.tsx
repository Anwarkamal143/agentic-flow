/**
 * Resume (ADR-0074): the wizard opens at the first step not completed, read
 * from the runtime's record of the last step completed. Once finished, the
 * verification step shows that it is.
 */
import { redirect } from 'next/navigation';
import { connection } from 'next/server';
import { RuntimeUnavailableNotice } from '@/components/states';
import { onboarding, RuntimeUnavailable } from '@/lib/runtime';

export default async function SetupPage() {
  await connection();
  let next: string | null;
  try {
    next = (await onboarding()).next;
  } catch (err) {
    if (err instanceof RuntimeUnavailable)
      return <RuntimeUnavailableNotice message={err.message} />;
    throw err;
  }
  redirect(`/setup/${next ?? 'verification'}`);
}
