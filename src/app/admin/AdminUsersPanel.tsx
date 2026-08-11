"use client";

import { useState } from "react";

export function AdminUsersPanel() {
  const [email, setEmail] = useState("");
  const [makeAdmin, setMakeAdmin] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, makeAdmin }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to create user.");
      setSuccess(`Invited ${email} — they'll get a temporary password by email.`);
      setEmail("");
      setMakeAdmin(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create user.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-3 rounded-md border border-zinc-800 p-4"
    >
      <label className="text-sm text-zinc-300">
        Email
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={submitting}
          placeholder="someone@example.com"
          className="mt-1 block w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm outline-none placeholder:text-zinc-500 focus:border-zinc-600 disabled:opacity-50"
        />
      </label>
      <label className="flex items-center gap-2 text-sm text-zinc-300">
        <input
          type="checkbox"
          checked={makeAdmin}
          onChange={(e) => setMakeAdmin(e.target.checked)}
          disabled={submitting}
          className="size-4 accent-zinc-300"
        />
        Make this user an admin too
      </label>
      {error && <p className="text-sm text-red-400">{error}</p>}
      {success && <p className="text-sm text-emerald-400">{success}</p>}
      <button
        type="submit"
        disabled={submitting || !email}
        className="self-start rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-emerald-950 transition hover:bg-emerald-400 disabled:opacity-40"
      >
        {submitting ? "Creating…" : "Create user"}
      </button>
    </form>
  );
}
