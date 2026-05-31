/**
 * POST /api/auth/login — authenticate with password.
 * Returns { ok: true } on success; throws on failure.
 */
export async function login(password: string): Promise<{ ok: boolean }> {
  const res = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `${res.status} ${res.statusText}`);
  }
  return res.json();
}

/**
 * POST /api/auth/logout — end the current session.
 */
export async function logout(): Promise<void> {
  await fetch("/api/auth/logout", { method: "POST" });
}
