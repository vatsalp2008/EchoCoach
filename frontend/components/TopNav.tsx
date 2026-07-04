"use client";

import Link from "next/link";
import { LogOut } from "lucide-react";
import { useAuth } from "./AuthProvider";
import ThemeToggle from "./ThemeToggle";

export default function TopNav() {
  const { user, loading, logout, openLogin, openSignup } = useAuth();

  return (
    <nav className="w-full border-b border-border bg-surface">
      <div className="mx-auto flex max-w-4xl items-center gap-6 px-4 py-3 text-sm">
        <Link href="/" className="text-base font-bold tracking-tight text-foreground">
          EchoCoach
        </Link>
        <Link href="/" className="text-muted transition-colors hover:text-foreground">
          Interview
        </Link>
        <Link href="/graph" className="text-muted transition-colors hover:text-foreground">
          Weakness graph
        </Link>

        <div className="ml-auto flex items-center gap-3">
          <ThemeToggle />
          {!loading && user ? (
            <div className="flex items-center gap-3">
              <span className="hidden text-sm text-muted sm:inline">
                {user.display_name}
              </span>
              <button
                type="button"
                onClick={logout}
                title="Sign out"
                className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 font-medium text-foreground transition-colors hover:bg-surface-2"
              >
                <LogOut size={15} />
                <span className="hidden sm:inline">Sign out</span>
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={openLogin}
                className="rounded-lg px-3 py-1.5 font-medium text-foreground transition-colors hover:bg-surface-2"
              >
                Log in
              </button>
              <button
                type="button"
                onClick={openSignup}
                className="rounded-lg bg-primary px-3.5 py-1.5 font-semibold text-primary-foreground transition-colors hover:bg-primary-hover"
              >
                Sign up
              </button>
            </div>
          )}
        </div>
      </div>
    </nav>
  );
}
