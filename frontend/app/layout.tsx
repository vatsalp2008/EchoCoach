import type { Metadata } from "next";
import Link from "next/link";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "EchoCoach",
  description: "The AI interviewer that remembers what you struggled with.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-neutral-50 text-neutral-900">
        <nav className="w-full border-b border-neutral-200 bg-white">
          <div className="mx-auto flex max-w-4xl items-center gap-6 px-4 py-3 text-sm">
            <Link href="/" className="font-semibold tracking-tight">
              EchoCoach
            </Link>
            <Link href="/" className="text-neutral-600 hover:text-neutral-900">
              Interview
            </Link>
            <Link href="/graph" className="text-neutral-600 hover:text-neutral-900">
              Weakness graph
            </Link>
          </div>
        </nav>
        {children}
      </body>
    </html>
  );
}
