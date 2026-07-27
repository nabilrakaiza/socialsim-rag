import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'social-sim-rag',
  description: 'A narrative, RAG-powered dating simulation.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
