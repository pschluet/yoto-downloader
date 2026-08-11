import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { ACCESS_TOKEN_COOKIE, clearSessionCookies, globalSignOut } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const accessToken = (await cookies()).get(ACCESS_TOKEN_COOKIE)?.value;
  if (accessToken) await globalSignOut(accessToken);

  return clearSessionCookies(NextResponse.json({ ok: true }));
}
