/**
 * A UI provider exposes either (a) a static directory the server should
 * mount at `/*` with SPA fallback, (b) a `mount(app)` hook that wires
 * custom routes on the Hono app, or both. The bundled web UI is registered
 * by the CLI as the "builtin" provider; third-party packages can register
 * additional providers via `registerUiProviderFactory`.
 */
export interface UiProvider {
  /** Registered id. Matches `server.ui.provider` in config. */
  id: string;
  /** Absolute path to a pre-built static bundle (index.html + assets). */
  staticDir?: string;
  /**
   * Optional hook to mount custom routes on the server's Hono app. Runs
   * before the static fallback so plugin routes win over the SPA index.
   * Typed as unknown to avoid forcing core to depend on hono.
   */
  mount?: (app: unknown) => void | Promise<void>;
}
