import type { Metadata } from 'next';
import './globals.css';
import { Shell } from '../components/shell';

export const metadata: Metadata = {
  title: 'cycgraph studio',
  description: 'Debug, improve, and monitor cycgraph runs.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
