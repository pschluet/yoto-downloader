"use client";

import { useCallback, useEffect, useState } from "react";
import { formatBytes } from "@/lib/format";
import type { CookieStatus } from "@/lib/cookies";

// Mirrors src/lib/cookies.ts's MAX_COOKIES_BYTES — kept as a plain constant
// here rather than importing the server module's value into a client bundle.
const MAX_COOKIES_BYTES = 512 * 1024;

const PLACEHOLDER =
  "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t1999999999\tSID\tvalue...";

function formatStatus(status: CookieStatus | null): string {
  if (!status?.present) return "No cookies uploaded yet.";
  const when = status.lastModified ? new Date(status.lastModified).toLocaleString() : "at some point";
  const by = status.uploadedBy ? ` by ${status.uploadedBy}` : "";
  const size = status.size != null ? ` (${formatBytes(status.size)})` : "";
  return `Uploaded ${when}${by}${size}.`;
}

export function AdminCookiesPanel() {
  const [status, setStatus] = useState<CookieStatus | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // loadingStatus only ever covers the initial mount fetch below (it starts
  // true) — later refreshes (after save/remove) update `status` directly
  // without re-showing "Checking…", since the Save/Test/Remove buttons'
  // own busy states already give feedback during those.
  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/cookies");
      const data = await res.json();
      if (res.ok) setStatus(data);
    } finally {
      setLoadingStatus(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // re-picking the same file must still fire onChange
    if (!file) return;
    if (file.size > MAX_COOKIES_BYTES) {
      setError("That file is too large (max 512 KB).");
      return;
    }
    setError(null);
    setText(await file.text());
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch("/api/admin/cookies", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cookies: text }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to save cookies.");
      setSuccess("Cookies saved.");
      setText("");
      await loadStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save cookies.");
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch("/api/admin/cookies/test", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Test failed.");
      setSuccess(`YouTube accepted the cookies — resolved "${data.title}".`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Test failed.");
    } finally {
      setTesting(false);
    }
  }

  async function handleRemove() {
    setRemoving(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch("/api/admin/cookies", { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to remove cookies.");
      setSuccess("Cookies removed.");
      await loadStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove cookies.");
    } finally {
      setRemoving(false);
    }
  }

  const busy = saving || testing || removing;

  return (
    <div className="flex flex-col gap-3 rounded-md border border-zinc-800 p-4">
      <p className="text-sm text-zinc-300">{loadingStatus ? "Checking…" : formatStatus(status)}</p>

      <form onSubmit={handleSave} className="flex flex-col gap-3">
        <label className="text-sm text-zinc-300">
          Paste cookies.txt contents, or choose a file
          <input
            type="file"
            accept=".txt,text/plain"
            disabled={busy}
            onChange={handleFileChange}
            className="mt-1 block w-full text-sm text-zinc-300 disabled:opacity-50"
          />
        </label>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={busy}
          rows={10}
          spellCheck={false}
          placeholder={PLACEHOLDER}
          className="block w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 font-mono text-xs outline-none placeholder:text-zinc-500 focus:border-zinc-600 disabled:opacity-50"
        />
        {error && <p className="text-sm text-red-400">{error}</p>}
        {success && <p className="text-sm text-emerald-400">{success}</p>}
        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={busy || !text.trim()}
            className="self-start rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-emerald-950 transition hover:bg-emerald-400 disabled:opacity-40"
          >
            {saving ? "Saving…" : "Save cookies"}
          </button>
          <button
            type="button"
            onClick={handleTest}
            disabled={busy || !status?.present}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-900 disabled:opacity-40"
          >
            {testing ? "Testing…" : "Test"}
          </button>
          {status?.present && (
            <button
              type="button"
              onClick={handleRemove}
              disabled={busy}
              className="text-xs text-red-400 hover:underline disabled:opacity-40"
            >
              {removing ? "Removing…" : "Remove"}
            </button>
          )}
        </div>
      </form>

      <p className="text-xs text-zinc-500">
        A cookie jar grants access to the Google account it came from — use a throwaway account, not
        your personal one. YouTube expires these periodically; re-upload here when the bot check
        reappears.
      </p>
    </div>
  );
}
