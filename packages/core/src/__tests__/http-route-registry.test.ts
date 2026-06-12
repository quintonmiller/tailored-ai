import { describe, expect, it } from "vitest";
import {
  createHttpRegistryView,
  HTTP_ROUTE_NAMESPACE,
  type HttpRouteDescriptor,
  HttpRouteRegistry,
} from "../http/registry.js";

const noopHandler: HttpRouteDescriptor["handler"] = async () => ({ status: 200, json: { ok: true } });

describe("HttpRouteRegistry", () => {
  it("namespaces a route under /api/ext when given a prefix", () => {
    const reg = new HttpRouteRegistry();
    const mountPath = reg.register({ method: "GET", path: "plans", handler: noopHandler }, "billing");
    expect(mountPath).toBe(`${HTTP_ROUTE_NAMESPACE}/billing/plans`);
    expect(reg.list()).toHaveLength(1);
    expect(reg.list()[0].mountPath).toBe("/api/ext/billing/plans");
  });

  it("mounts under /api/ext with no prefix", () => {
    const reg = new HttpRouteRegistry();
    const mountPath = reg.register({ method: "POST", path: "/hook", handler: noopHandler });
    expect(mountPath).toBe(`${HTTP_ROUTE_NAMESPACE}/hook`);
  });

  it("normalizes leading/trailing slashes in path and prefix", () => {
    const reg = new HttpRouteRegistry();
    const mountPath = reg.register({ method: "GET", path: "/list/", handler: noopHandler }, "/things/");
    expect(mountPath).toBe("/api/ext/things/list");
  });

  it("preserves :param segments in the mount path", () => {
    const reg = new HttpRouteRegistry();
    const mountPath = reg.register({ method: "POST", path: "items/:id/run", handler: noopHandler }, "jobs");
    expect(mountPath).toBe("/api/ext/jobs/items/:id/run");
  });

  it("throws on a duplicate method + mountPath", () => {
    const reg = new HttpRouteRegistry();
    reg.register({ method: "GET", path: "x", handler: noopHandler }, "p");
    expect(() => reg.register({ method: "GET", path: "x", handler: noopHandler }, "p")).toThrow(/already registered/);
  });

  it("allows same path with different methods", () => {
    const reg = new HttpRouteRegistry();
    reg.register({ method: "GET", path: "x", handler: noopHandler }, "p");
    reg.register({ method: "POST", path: "x", handler: noopHandler }, "p");
    expect(reg.list()).toHaveLength(2);
  });

  it("deregister removes a route and reports whether it matched", () => {
    const reg = new HttpRouteRegistry();
    const mountPath = reg.register({ method: "GET", path: "x", handler: noopHandler }, "p");
    expect(reg.deregister("GET", mountPath)).toBe(true);
    expect(reg.list()).toHaveLength(0);
    expect(reg.deregister("GET", mountPath)).toBe(false);
  });

  describe("absolute routes", () => {
    it("mounts at the verbatim path, ignoring prefix and namespace", () => {
      const reg = new HttpRouteRegistry();
      const mountPath = reg.register(
        { method: "POST", path: "/api/trusted-actions/callback", handler: noopHandler, absolute: true },
        "ignored",
      );
      expect(mountPath).toBe("/api/trusted-actions/callback");
    });

    it("rejects an absolute path that does not start with /", () => {
      const reg = new HttpRouteRegistry();
      expect(() => reg.register({ method: "GET", path: "no-slash", handler: noopHandler, absolute: true })).toThrow(
        /must start with/,
      );
    });
  });

  describe("mount(prefix, routes[])", () => {
    it("registers each route under the shared prefix and returns mount paths", () => {
      const reg = new HttpRouteRegistry();
      const paths = reg.mount("billing", [
        { method: "GET", path: "plans", handler: noopHandler },
        { method: "POST", path: "subscribe", handler: noopHandler },
      ]);
      expect(paths).toEqual(["/api/ext/billing/plans", "/api/ext/billing/subscribe"]);
      expect(reg.list()).toHaveLength(2);
    });
  });

  describe("createHttpRegistryView", () => {
    it("bakes the default prefix into register()", () => {
      const reg = new HttpRouteRegistry();
      const view = createHttpRegistryView(reg, "my-plugin");
      view.register({ method: "GET", path: "status", handler: noopHandler });
      expect(reg.list()[0].mountPath).toBe("/api/ext/my-plugin/status");
    });

    it("nests mount() under <defaultPrefix>/<prefix>/", () => {
      const reg = new HttpRouteRegistry();
      const view = createHttpRegistryView(reg, "my-plugin");
      view.mount("admin", [{ method: "GET", path: "stats", handler: noopHandler }]);
      expect(reg.list()[0].mountPath).toBe("/api/ext/my-plugin/admin/stats");
    });

    it("register() returns a disposer that deregisters the route", () => {
      const reg = new HttpRouteRegistry();
      const view = createHttpRegistryView(reg, "my-plugin");
      const dispose = view.register({ method: "GET", path: "status", handler: noopHandler });
      expect(reg.list()).toHaveLength(1);
      dispose();
      expect(reg.list()).toHaveLength(0);
      // Re-registration after dispose succeeds (the reload contract).
      expect(() => view.register({ method: "GET", path: "status", handler: noopHandler })).not.toThrow();
    });

    it("an absolute route still mounts verbatim through the view", () => {
      const reg = new HttpRouteRegistry();
      const view = createHttpRegistryView(reg, "my-plugin");
      view.register({ method: "POST", path: "/legacy/path", handler: noopHandler, absolute: true });
      expect(reg.list()[0].mountPath).toBe("/legacy/path");
    });
  });
});
