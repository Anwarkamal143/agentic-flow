import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'Software Factory',
  description: 'Read-only view of the factory’s Jobs',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <header className="border-b">
          <div className="mx-auto flex max-w-6xl items-center gap-6 px-4 py-3">
            <Link href="/" className="font-semibold">
              Software Factory
            </Link>
            <nav aria-label="Main">
              <Link href="/" className="text-sm text-muted-foreground hover:text-foreground">
                Jobs
              </Link>
            </nav>
            <span className="ml-auto text-xs text-muted-foreground">
              Read-only. Changes go through the <code>factory</code> CLI.
            </span>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
      </body>
    </html>
  );
}
