import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AdminUsersPanel } from "./AdminUsersPanel";

export default async function AdminPage() {
  // Belt and braces: middleware already gates every page, but re-check the
  // Admins-group claim here too rather than assume no other route could
  // ever render this component.
  const requestHeaders = await headers();
  const groups = requestHeaders.get("x-user-groups")?.split(",") ?? [];
  if (!groups.includes("Admins")) {
    redirect("/");
  }

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-12">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">Admin</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Create additional users. They&rsquo;ll receive a temporary password
            by email and be asked to set a new one on first sign-in.
          </p>
        </header>
        <AdminUsersPanel />
      </div>
    </main>
  );
}
