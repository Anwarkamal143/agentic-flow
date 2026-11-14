/**
 * The dashboard's only write path (ADR-0022): the Inbox's forms post here, and
 * the change goes to the runtime API server-side, as `user:local`, so the token
 * never reaches the browser. A write is accepted only addressed to a loopback
 * `Host` from the dashboard's own `Origin`, and it names the item's version
 * (and, to decide, its subject and option) as the page showed them. The
 * runtime refuses a stale one; its message is shown as it is.
 *
 * The forms work without scripts: success is a 303 to the item's page, a
 * refusal a small HTML page with the reason and a link back.
 */
import { z } from 'zod';
import { checkWriteOrigin } from '@/lib/loopback';
import { changeInboxItem, RuntimeUnavailable, type InboxAction } from '@/lib/runtime';

export const dynamic = 'force-dynamic';

const ID = /^[A-Za-z0-9_-]{1,100}$/;
const ACTIONS: readonly InboxAction[] = ['decide', 'answer', 'defer', 'undefer'];
/** A question id (`q1`…, `scope`) in an answer form's field names. */
const QUESTION_ID = /^(?:q\d{1,3}|scope)$/;
/** The radio value that means "my own answer, in the text box". */
const OWN_ANSWER = '__text';
/** Where a change may send the browser back to: the Inbox or one of its items. */
const RETURN = /^\/inbox(\/[A-Za-z0-9_-]{1,100}|\?all=true)?$/;

const version = z
  .string()
  .regex(/^\d{1,9}$/)
  .transform(Number);
const comment = z
  .string()
  .max(5000)
  .optional()
  .transform((c) => (c === undefined || c.trim() === '' ? undefined : c));
const FORMS = {
  decide: z
    .object({
      expectedVersion: version,
      subjectRef: z.string().min(1).max(200),
      option: z.string().min(1).max(40),
      comment,
      /** A Blocker Approval's grant size; the runtime checks its range (ADR-0026). */
      grant: z
        .string()
        .regex(/^\d{0,3}$/)
        .optional(),
    })
    // The grant field is on the whole form, so it is sent only with the grant option.
    .transform(({ grant, ...rest }) =>
      rest.option === 'grant' && grant !== undefined && grant !== ''
        ? { ...rest, grant: Number(grant) }
        : rest,
    ),
  answer: z.object({
    expectedVersion: version,
    subjectRef: z.string().min(1).max(200),
  }),
  defer: z.object({ expectedVersion: version }),
  undefer: z.object({ expectedVersion: version }),
} as const;

/**
 * An answer form's answers: per question, `choice.<id>` (an offered option,
 * or {@link OWN_ANSWER}) and `text.<id>` (free text). An option and text both
 * given are both sent, so the runtime refuses the answer instead of the
 * dashboard dropping one. A question with neither is left unanswered.
 */
function answersOf(fields: Record<string, string>) {
  const ids = new Set(
    Object.keys(fields)
      .map((k) => /^(?:choice|text)\.(.+)$/.exec(k)?.[1])
      .filter((id): id is string => id !== undefined && QUESTION_ID.test(id)),
  );
  return [...ids].sort().flatMap((questionId) => {
    const choice = fields[`choice.${questionId}`];
    const text = fields[`text.${questionId}`]?.trim();
    const option =
      choice !== undefined && choice !== OWN_ANSWER && choice !== '' ? choice : undefined;
    const own = text === undefined || text === '' ? undefined : text;
    if (option === undefined && own === undefined) return [];
    return [
      {
        questionId,
        ...(option === undefined ? {} : { option: option.slice(0, 5000) }),
        ...(own === undefined ? {} : { text: own.slice(0, 5000) }),
      },
    ];
  });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; action: string }> },
): Promise<Response> {
  const forbidden = checkWriteOrigin(request.headers);
  if (forbidden !== undefined) return Response.json({ error: forbidden }, { status: 403 });

  const { id, action } = await params;
  if (!ID.test(id) || !isAction(action)) {
    return Response.json({ error: 'not_found' }, { status: 404 });
  }
  let fields: Record<string, string>;
  try {
    fields = Object.fromEntries(
      [...(await request.formData()).entries()].flatMap(([k, v]) =>
        typeof v === 'string' ? [[k, v]] : [],
      ),
    );
  } catch {
    return Response.json({ error: 'invalid_request' }, { status: 400 });
  }
  const form = FORMS[action].safeParse(fields);
  if (!form.success) return Response.json({ error: 'invalid_request' }, { status: 400 });
  const back =
    fields['return'] !== undefined && RETURN.test(fields['return'])
      ? fields['return']
      : `/inbox/${id}`;

  try {
    const result = await changeInboxItem(
      id,
      action,
      action === 'answer' ? { ...form.data, answers: answersOf(fields) } : form.data,
    );
    if (result.ok) return new Response(null, { status: 303, headers: { location: back } });
    return refusal(result.status, `The ${action} was refused`, result.message, id);
  } catch (err) {
    if (err instanceof RuntimeUnavailable) {
      return refusal(503, 'The factory runtime is unavailable', err.message, id);
    }
    throw err;
  }
}

function isAction(value: string): value is InboxAction {
  return (ACTIONS as readonly string[]).includes(value);
}

/** A page a browser without scripts can show: what was refused, why, and the way back. */
function refusal(status: number, title: string, message: string, id: string): Response {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escape(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;line-height:1.5}</style>
</head><body><main role="alert">
<h1>${escape(title)}</h1>
<p>${escape(message)}</p>
<p>Nothing was changed. <a href="/inbox/${escape(id)}">Back to the item</a>, re-read it, and decide again.</p>
</main></body></html>`;
  return new Response(html, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function escape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
