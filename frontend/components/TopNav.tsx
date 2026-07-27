"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import { LogOut } from "lucide-react";
import { useAuth } from "./AuthProvider";
import ThemeToggle from "./ThemeToggle";

const NAV_LINKS = [
  { href: "/graph", label: "Weakness graph" },
  { href: "/history", label: "History" },
];

export default function TopNav() {
  const { user, loading, logout } = useAuth();
  const pathname = usePathname();

  return (
    <nav className="w-full border-b border-border bg-surface">
      <div className="mx-auto flex max-w-4xl items-center gap-6 px-4 py-3 text-sm">
        <Link href="/" className="text-base font-bold tracking-tight text-foreground">
          EchoCoach
        </Link>
        {!loading && user && (
          <>
            {NAV_LINKS.map(({ href, label }) => {
              const active = pathname === href;
              return (
                <Link
                  key={href}
                  href={href}
                  className={
                    "relative pb-1 transition-colors " +
                    (active ? "text-foreground" : "text-muted hover:text-foreground")
                  }
                >
                  {label}
                  {active && (
                    <motion.span
                      layoutId="nav-underline"
                      className="absolute inset-x-0 -bottom-[13px] h-0.5 bg-primary"
                      transition={{ type: "spring", stiffness: 380, damping: 30 }}
                    />
                  )}
                </Link>
              );
            })}
          </>
        )}

        <div className="ml-auto flex items-center gap-3">
          <ThemeToggle />
          {!loading && user && (
            <div className="flex items-center gap-3">
              <span className="hidden text-sm text-muted sm:inline">
                {user.display_name}
              </span>
              <button
                type="button"
                onClick={logout}
                title="Sign out"
                className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 font-medium text-foreground transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <LogOut size={15} />
                <span className="hidden sm:inline">Sign out</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </nav>
  );
}
