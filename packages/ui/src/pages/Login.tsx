import { useState } from "react";

export default function Login() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });

      if (res.ok) {
        // Full reload rather than a hash change: the session cookie is set now,
        // and every earlier failed request left its component in an error state.
        window.location.href = "/";
        return;
      }
      // The server answers with {"error": "..."} — a wrong password, or a
      // throttle notice that says how long to wait. Showing the raw body
      // would print the JSON at the reader.
      const body = await res.text();
      let message = body;
      try {
        const parsed = JSON.parse(body) as { error?: string };
        if (parsed?.error) message = parsed.error;
      } catch {
        // Not JSON. Fall through to the raw text.
      }
      setError(message || `Login failed (${res.status})`);
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login">
      <form onSubmit={handleSubmit}>
        <h2>Authenticate</h2>
        <label>
          <span className="login-label">Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Enter password"
            disabled={loading}
          />
        </label>
        {error && <p className="login-error">{error}</p>}
        <button type="submit" disabled={loading}>
          {loading ? "Authenticating…" : "Login"}
        </button>
      </form>
    </div>
  );
}
