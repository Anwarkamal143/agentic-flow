import { randomBytes } from 'node:crypto';

/** A new random id with a type prefix, e.g. `job_3f9c…`. */
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString('hex')}`;
}
