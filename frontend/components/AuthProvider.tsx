"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTheme } from "next-themes";
import { X } from "lucide-react";
import {
  getMe,
  googleSignin,
  login as apiLogin,
  logout as apiLogout,
  signup as apiSignup,
  User,
} from "@/lib/api";

const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;

type Mode = "login" | "signup";

interface AuthCtx {
  user: User | null;
  loading: boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
  openLogin: () => void;
  openSignup: () => void;
}

const Ctx = createContext<AuthCtx | null>(null);

export function useAuth(): AuthCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAuth must be used within <AuthProvider>");
  return ctx;
}

export default function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<Mode | null>(null);

  const refresh = useCallback(async () => {
    try {
      setUser(await getMe());
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const logout = useCallback(async () => {
    try {
      await apiLogout();
    } finally {
      setUser(null);
    }
  }, []);

  const value: AuthCtx = {
    user,
    loading,
    refresh,
    logout,
    openLogin: () => setMode("login"),
    openSignup: () => setMode("signup"),
  };

  return (
    <Ctx.Provider value={value}>
      {children}
      {mode && (
        <AuthModal
          mode={mode}
          switchMode={setMode}
          onClose={() => setMode(null)}
          onSuccess={(u) => {
            setUser(u);
            setMode(null);
          }}
        />
      )}
    </Ctx.Provider>
  );
}

const inputCls =
  "w-full rounded-lg border border-border bg-surface px-3.5 py-2.5 text-base text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-ring/40 placeholder:text-muted/70";
const labelCls = "block text-[15px] font-medium text-foreground mb-1.5";

function AuthModal({
  mode,
  switchMode,
  onClose,
  onSuccess,
}: {
  mode: Mode;
  switchMode: (m: Mode) => void;
  onClose: () => void;
  onSuccess: (u: User) => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const isSignup = mode === "signup";
  const { resolvedTheme } = useTheme();
  const googleBtnRef = useRef<HTMLDivElement>(null);

  // Render the Google Identity Services button (ID-token flow). The callback
  // receives an ID token which we POST to the backend for verification.
  useEffect(() => {
    if (!GOOGLE_CLIENT_ID || !googleBtnRef.current) return;

    const render = () => {
      const g = (window as { google?: any }).google;
      if (!g?.accounts?.id || !googleBtnRef.current) return;
      g.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: async (resp: { credential: string }) => {
          try {
            onSuccess(await googleSignin(resp.credential));
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
  }, [isSignup, resolvedTheme, onSuccess]);

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
      const u = isSignup
        ? await apiSignup(name.trim(), email.trim(), password)
        : await apiLogin(email.trim(), password);
      onSuccess(u);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-border bg-surface p-7 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-5 flex items-start justify-between">
          <div>
            <h2 className="text-2xl font-bold tracking-tight text-foreground">
              {isSignup ? "Create your account" : "Welcome back"}
            </h2>
            <p className="mt-1 text-sm text-muted">
              {isSignup
                ? "Start building your personal weakness graph."
                : "Log in to continue where you left off."}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1 text-muted hover:bg-surface-2 hover:text-foreground"
          >
            <X size={20} />
          </button>
        </div>

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
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={isSignup ? "At least 8 characters" : "••••••••"}
              className={inputCls}
            />
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
              switchMode(isSignup ? "login" : "signup");
            }}
            className="font-semibold text-primary hover:underline"
          >
            {isSignup ? "Log in" : "Sign up"}
          </button>
        </p>
      </div>
    </div>
  );
}
