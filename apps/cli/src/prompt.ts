import { createInterface } from 'node:readline';

/** Reads one line from stdin. Resolves undefined if stdin ends first. */
export async function ask(prompt: string): Promise<string | undefined> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  process.stdout.write(prompt);
  try {
    for await (const line of rl) return line;
    return undefined;
  } finally {
    rl.close();
    process.stdout.write('\n');
  }
}
