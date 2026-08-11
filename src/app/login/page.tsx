"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const searchParams = useSearchParams();
  const next = searchParams.get("next") || "/";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Set once Cognito returns a NEW_PASSWORD_REQUIRED challenge (always true
  // for an admin-created user's first sign-in).
  const [challengeSession, setChallengeSession] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Sign-in failed.");

      if (data.challenge === "NEW_PASSWORD_REQUIRED") {
        setChallengeSession(data.session as string);
        return;
      }

      // Full navigation, not router.push — ensures middleware sees the
      // just-set session cookies on the very next request.
      window.location.href = next;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSetNewPassword(e: React.FormEvent) {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      setError("Passwords don't match.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/challenge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, newPassword, session: challengeSession }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not set new password.");
      window.location.href = next;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not set new password.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-950 text-zinc-100">
      <div className="w-full max-w-sm px-6">
        <h1 className="mb-1 text-2xl font-semibold tracking-tight">YouTube → MP3</h1>
        <p className="mb-6 text-sm text-zinc-400">
          {challengeSession ? "Choose a new password to finish signing in." : "Sign in to continue."}
        </p>

        {!challengeSession ? (
          <form onSubmit={handleLogin} className="flex flex-col gap-3">
            <input
              type="email"
              required
              autoComplete="email"
              placeholder="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={submitting}
              className="rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm outline-none placeholder:text-zinc-500 focus:border-zinc-600 disabled:opacity-50"
            />
            <input
              type="password"
              required
              autoComplete="current-password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={submitting}
              className="rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm outline-none placeholder:text-zinc-500 focus:border-zinc-600 disabled:opacity-50"
            />
            {error && <p className="text-sm text-red-400">{error}</p>}
            <button
              type="submit"
              disabled={submitting || !email || !password}
              className="mt-1 rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-emerald-950 transition hover:bg-emerald-400 disabled:opacity-40"
            >
              {submitting ? "Signing in…" : "Sign in"}
            </button>
          </form>
        ) : (
          <form onSubmit={handleSetNewPassword} className="flex flex-col gap-3">
            <input
              type="password"
              required
              autoComplete="new-password"
              placeholder="New password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              disabled={submitting}
              className="rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm outline-none placeholder:text-zinc-500 focus:border-zinc-600 disabled:opacity-50"
            />
            <input
              type="password"
              required
              autoComplete="new-password"
              placeholder="Confirm new password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              disabled={submitting}
              className="rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm outline-none placeholder:text-zinc-500 focus:border-zinc-600 disabled:opacity-50"
            />
            {error && <p className="text-sm text-red-400">{error}</p>}
            <button
              type="submit"
              disabled={submitting || !newPassword || !confirmPassword}
              className="mt-1 rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-emerald-950 transition hover:bg-emerald-400 disabled:opacity-40"
            >
              {submitting ? "Saving…" : "Set password and sign in"}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
