import type { EffectiveConfig } from '@factory/domain';
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

/** One resolved value as the runtime returned it: the value, its source level and any chain. */
interface Effective {
  value: unknown;
  source: string;
  chain?: { source: string; value: string }[] | undefined;
}

/** A value as text, the way `job show` prints it: lists joined, objects by their keys. */
function shown(key: string, value: unknown): string {
  if (value === null || value === undefined) return 'none';
  if (Array.isArray(value)) {
    if (value.length === 0) return key === 'requiredChecks' ? 'every check' : 'none';
    return value.map(String).join(', ');
  }
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([k, x]) => (typeof x === 'object' && x !== null ? k : `${k}=${shown(k, x)}`))
      .join(', ');
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** The Job-wide values, in `job show`'s order, then a pre-Phase D Job's top-level Repository values. */
function jobWide(config: EffectiveConfig): [string, Effective][] {
  const { concurrency, mergePolicy, setup, ...rest } = config;
  // The Repository sections are shown on their own, below.
  const settings: Omit<typeof rest, 'repositories'> = rest;
  const rows: [string, Effective][] = [
    ...Object.entries(settings).filter(([key]) => key !== 'repositories'),
    ...Object.entries(concurrency).map(([key, v]): [string, Effective] => [
      `concurrency.${key}`,
      v,
    ]),
  ];
  if (mergePolicy !== undefined) rows.push(['mergePolicy', mergePolicy]);
  if (setup !== undefined) rows.push(['setup', setup]);
  return rows;
}

function Rows({ rows, prefix }: { rows: [string, Effective][]; prefix: string }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Key</TableHead>
          <TableHead>Value</TableHead>
          <TableHead>Source</TableHead>
          <TableHead>Narrowed by</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map(([key, v]) => (
          <TableRow key={key} data-config-key={prefix + key}>
            <TableCell className="font-mono text-xs">{key}</TableCell>
            <TableCell className="font-mono text-xs break-words">{shown(key, v.value)}</TableCell>
            <TableCell>
              <Badge variant="outline">{v.source}</Badge>
            </TableCell>
            <TableCell className="text-xs">
              {v.chain !== undefined && v.chain.length >= 2
                ? v.chain.map((c) => `${c.source}: ${c.value}`).join(' → ')
                : null}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** What a preview is, and what it is not. */
export function PreviewNote() {
  return (
    <>
      This is what a new Job would get now, resolved from the stored levels at this read. Jobs
      already created keep the configuration they froze at creation. Change a value with{' '}
      <code>factory config set</code> or <code>factory project config set</code>.
    </>
  );
}

/**
 * An Effective Configuration (ADR-0057): each key with its value, the level it came
 * from and, for a permission value set at two or more levels, the chain of narrowings.
 * Then one section per Repository. Shows only what the runtime returned.
 */
export function EffectiveConfigCard({
  config,
  title,
  description,
}: {
  config: EffectiveConfig;
  title: string;
  description: ReactNode;
}) {
  return (
    <Card data-testid="effective-config" id="configuration">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <Rows rows={jobWide(config)} prefix="" />
        {config.repositories.map(({ repositoryId, name, ...values }) => (
          <div key={repositoryId} className="space-y-2">
            <h3 className="text-sm font-medium">
              Repository <code className="font-mono">{name}</code>{' '}
              <span className="font-mono text-xs text-muted-foreground">{repositoryId}</span>
            </h3>
            <Rows rows={Object.entries(values)} prefix={`${name}/`} />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
