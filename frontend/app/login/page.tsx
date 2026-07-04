"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useTheme } from "next-themes";
import { Eye, EyeOff } from "lucide-react";
import { googleSignin, login as apiLogin, signup as apiSignup } from "@/lib/api";
import { useAuth } from "@/components/AuthProvider";

const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
const inputCls =
  "w-full rounded-lg border border-border bg-surface px-3.5 py-2.5 text-base text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-ring/40 placeholder:text-muted/60";
const labelCls = "block text-[15px] font-medium text-foreground mb-1.5";

export default function LoginPage() {
  const router = useRouter();
  const { user, loading, refresh } = useAuth();
  const { resolvedTheme } = useTheme();

  const [mode, setMode] = useState<"login" | "signup">("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const googleBtnRef = useRef<HTMLDivElement>(null);
  const isSignup = mode === "signup";

  // Already logged in? Skip straight to the app.
  useEffect(() => {
    if (!loading && user) router.replace("/");
  }, [loading, user, router]);

  async function done() {
    await refresh();
    router.replace("/");
  }

  // Google Identity Services button (ID-token flow), same as the modal.
  useEffect(() => {
    if (!GOOGLE_CLIENT_ID || !googleBtnRef.current) return;
    const render = () => {
      const g = (window as { google?: any }).google;
      if (!g?.accounts?.id || !googleBtnRef.current) return;
      g.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: async (resp: { credential: string }) => {
          try {
            await googleSignin(resp.credential);
            await done();
          } catch (e) {
            setError(e instanceof Error ? e.message : "Google sign-in failed.");
          }
        },
      });
      googleBtnRef.current.innerHTML = "";
      g.accounts.id.renderButton(googleBtnRef.current, {
        theme: resolvedTheme === "dark" ? "filled_black" : "outline",
        size: "large",
        text: isSignup ? "signup_with" : "signin_with",
        width: 360,
      });
    };
    if ((window as { google?: any }).google?.accounts?.id) {
      render();
      return;
    }
    let s = document.getElementById("gis-script") as HTMLScriptElement | null;
    if (!s) {
      s = document.createElement("script");
      s.src = "https://accounts.google.com/gsi/client";
      s.async = true;
      s.defer = true;
      s.id = "gis-script";
      document.body.appendChild(s);
    }
    s.addEventListener("load", render);
    return () => s?.removeEventListener("load", render);
  }, [isSignup, resolvedTheme]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      setError("Please enter a valid email address.");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (isSignup && !name.trim()) {
      setError("Please enter your name.");
      return;
    }
    setBusy(true);
    try {
      if (isSignup) await apiSignup(name.trim(), email.trim(), password);
      else await apiLogin(email.trim(), password);
      await done();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-[calc(100vh-3.25rem)] flex-col items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <h1 className="text-3xl font-bold tracking-tight text-foreground">
            {isSignup ? "Create your account" : "Welcome back"}
          </h1>
          <p className="mt-2 text-base text-muted">
            {isSignup
              ? "Start building your personal weakness graph."
              : "Log in to continue where you left off."}
          </p>
        </div>

        <div className="rounded-2xl border border-border bg-surface p-7 shadow-sm">
          {GOOGLE_CLIENT_ID && (
            <div className="mb-5">
              <div ref={googleBtnRef} className="flex justify-center" />
              <div className="my-4 flex items-center gap-3 text-xs text-muted">
                <span className="h-px flex-1 bg-border" />
                or continue with email
                <span className="h-px flex-1 bg-border" />
              </div>
            </div>
          )}

          <form onSubmit={submit} className="space-y-4">
            {isSignup && (
              <div>
                <label className={labelCls}>Name</label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="John Doe"
                  className={inputCls}
                  autoFocus
                />
              </div>
            )}
            <div>
              <label className={labelCls}>Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className={inputCls}
                autoFocus={!isSignup}
              />
            </div>
            <div>
              <label className={labelCls}>Password</label>
              <div className="relative">
                <input
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={isSignup ? "At least 8 characters" : "••••••••"}
                  className={inputCls + " pr-11"}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((s) => !s)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  title={showPassword ? "Hide password" : "Show password"}
                  className="absolute inset-y-0 right-0 grid w-11 place-items-center text-muted transition-colors hover:text-foreground"
                >
                  {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </div>

            {error && (
              <p className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-300">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-xl bg-primary px-5 py-3 text-base font-semibold text-primary-foreground transition hover:bg-primary-hover disabled:opacity-50"
            >
              {busy ? "Please wait…" : isSignup ? "Create account" : "Log in"}
            </button>
          </form>

          <p className="mt-5 text-center text-sm text-muted">
            {isSignup ? "Already have an account?" : "New to EchoCoach?"}{" "}
            <button
              type="button"
              onClick={() => {
                setError("");
                setMode(isSignup ? "login" : "signup");
              }}
              className="font-semibold text-primary hover:underline"
            >
              {isSignup ? "Log in" : "Sign up"}
            </button>
          </p>
        </div>

        <p className="mt-6 text-center text-sm">
          <Link href="/" className="text-muted hover:text-foreground">
            ← Back to home
          </Link>
        </p>
      </div>
    </main>
  );
}
