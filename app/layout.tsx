import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'social-sim-rag',
  description: 'A narrative, RAG-powered dating simulation.',
};

export const viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fbfaf9' },
    { media: '(prefers-color-scheme: dark)', color: '#12100f' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
