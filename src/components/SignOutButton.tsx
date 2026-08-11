"use client";

export function SignOutButton() {
  async function handleSignOut() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    // A full reload, not router.push — guarantees the next request is
    // re-evaluated by middleware against the now-cleared session cookies,
    // rather than risking a stale client-side render.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.href = "/login";
  }

  return (
    <button
      onClick={handleSignOut}
      className="rounded-md border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-900"
    >
      Sign out
    </button>
  );
}
