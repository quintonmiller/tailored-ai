import { beforeEach, describe, expect, it } from "vitest";
import {
  _resetEgressPolicy,
  activeSessionIds,
  hasActiveMediatorSession,
  isHostAllowed,
  registerMediatorSession,
  unregisterMediatorSession,
} from "../egress-policy.js";

describe("egress crosstalk policy", () => {
  beforeEach(() => _resetEgressPolicy());

  it("allows everything when no session is active", () => {
    expect(hasActiveMediatorSession()).toBe(false);
    expect(isHostAllowed("anywhere.example")).toBe(true);
  });

  it("blocks hosts outside an active session's allow-list", () => {
    registerMediatorSession("s1", ["amazon.com"]);
    expect(hasActiveMediatorSession()).toBe(true);
    expect(isHostAllowed("amazon.com")).toBe(true);
    expect(isHostAllowed("www.amazon.com")).toBe(true);
    expect(isHostAllowed("attacker.test")).toBe(false);
  });

  it("intersects allow-lists when multiple sessions are active", () => {
    // s1 allows amazon + tai. s2 allows only amazon. Intersection: amazon only.
    // Closes the "open a second permissive session to widen the first" attack.
    registerMediatorSession("s1", ["amazon.com", "tai.local"]);
    registerMediatorSession("s2", ["amazon.com"]);
    expect(isHostAllowed("amazon.com")).toBe(true);
    expect(isHostAllowed("tai.local")).toBe(false);
  });

  it("unregister restores prior policy", () => {
    registerMediatorSession("s1", ["amazon.com"]);
    expect(isHostAllowed("tai.local")).toBe(false);
    unregisterMediatorSession("s1");
    expect(hasActiveMediatorSession()).toBe(false);
    expect(isHostAllowed("tai.local")).toBe(true);
  });

  it("treats empty allow-list as deny-all", () => {
    registerMediatorSession("s1", []);
    expect(isHostAllowed("amazon.com")).toBe(false);
    expect(isHostAllowed("anywhere.test")).toBe(false);
  });

  it("tracks active session ids", () => {
    registerMediatorSession("s1", ["a.test"]);
    registerMediatorSession("s2", ["b.test"]);
    expect(activeSessionIds().sort()).toEqual(["s1", "s2"]);
  });
});
