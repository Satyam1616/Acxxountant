import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "LedgerFlow — Cash application, without the busywork",
  description: "AI-assisted accounts receivable and bank reconciliation workspace.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
