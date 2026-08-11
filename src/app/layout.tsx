import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import { SignOutButton } from "@/components/SignOutButton";
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
  title: "YouTube → MP3",
  description: "Download audio from a YouTube playlist or video as MP3.",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // Set by src/middleware.ts once it's verified a session — absent on
  // /login and the /api/auth/* routes, which middleware doesn't run on, so
  // this doubles as "is the visitor signed in" without re-checking here.
  const requestHeaders = await headers();
  const email = requestHeaders.get("x-user-email");
  const isAdmin = requestHeaders.get("x-user-groups")?.split(",").includes("Admins") ?? false;

  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {email && (
          <header className="flex items-center justify-between border-b border-zinc-800 bg-zinc-950 px-6 py-3 text-sm">
            <div className="flex items-center gap-4">
              <span className="text-zinc-500">{email}</span>
              {isAdmin && (
                <a
                  href="/admin"
                  className="text-zinc-300 underline decoration-zinc-700 hover:text-zinc-100"
                >
                  Admin
                </a>
              )}
            </div>
            <SignOutButton />
          </header>
        )}
        {children}
      </body>
    </html>
  );
}
