import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

/** The monorepo root, so Turbopack resolves the workspace packages (`@factory/*`). */
const root = fileURLToPath(new URL('../..', import.meta.url));

const config: NextConfig = {
  turbopack: { root },
  outputFileTracingRoot: root,
  poweredByHeader: false,
  // Next writes an AGENTS.md into the app otherwise; this repo's agent rules live in CLAUDE.md.
  agentRules: false,
};

export default config;
