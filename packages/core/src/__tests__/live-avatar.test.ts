/**
 * Where the Talk page's avatar file is: an absolute path as given, a bare
 * name under the instance's own avatars folder, nothing when unset.
 */
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { avatarAnimationPaths, avatarModelPath, resolveAvatar } from "../live/avatar.js";

let original: string | undefined;
beforeEach(() => {
  original = process.env.TAI_HOME;
  process.env.TAI_HOME = "/srv/tai-home";
});
afterEach(() => {
  if (original === undefined) delete process.env.TAI_HOME;
  else process.env.TAI_HOME = original;
});

describe("avatarModelPath", () => {
  it("is undefined when no avatar is set, or the setting is blank", () => {
    expect(avatarModelPath(undefined)).toBeUndefined();
    expect(avatarModelPath({})).toBeUndefined();
    expect(avatarModelPath({ avatar: {} })).toBeUndefined();
    expect(avatarModelPath({ avatar: { model: "  " } })).toBeUndefined();
  });

  it("keeps an absolute path as given", () => {
    expect(avatarModelPath({ avatar: { model: "/models/bot.vrm" } })).toBe("/models/bot.vrm");
  });

  it("looks for a relative path in the instance's avatars folder", () => {
    expect(avatarModelPath({ avatar: { model: "bot.vrm" } })).toBe(join("/srv/tai-home", "avatars", "bot.vrm"));
  });
});

describe("avatarAnimationPaths", () => {
  it("resolves each library the way the model is resolved, in order", () => {
    expect(avatarAnimationPaths({ avatar: { model: "bot.vrm", animations: ["anim/a.glb", "/libs/b.glb"] } })).toEqual([
      join("/srv/tai-home", "avatars", "anim/a.glb"),
      "/libs/b.glb",
    ]);
  });

  it("has none without a model to play them on, or none configured", () => {
    expect(avatarAnimationPaths({ avatar: { animations: ["a.glb"] } })).toEqual([]);
    expect(avatarAnimationPaths({ avatar: { model: "bot.vrm" } })).toEqual([]);
  });
});

describe("resolveAvatar", () => {
  const live = { avatar: { model: "robot.vrm", animations: ["moves.glb"] } };
  const home = (...p: string[]) => join("/srv/tai-home", "avatars", ...p);

  it("gives an agent without its own avatar the deployment's", () => {
    expect(resolveAvatar(live)).toEqual({ model: home("robot.vrm"), animations: [home("moves.glb")] });
  });

  it("lets an agent wear its own model, still playing the deployment's animations", () => {
    expect(resolveAvatar(live, { model: "fox.vrm" })).toEqual({
      model: home("fox.vrm"),
      animations: [home("moves.glb")],
    });
    expect(resolveAvatar(live, { model: "fox.vrm", animations: [] })).toEqual({
      model: home("fox.vrm"),
      animations: [],
    });
  });

  it("gives an agent no body at all with avatar: false, even when the deployment has one", () => {
    expect(resolveAvatar(live, false)).toEqual({ animations: [] });
  });

  it("has no body when neither the agent nor the deployment names a model", () => {
    expect(resolveAvatar({}, { animations: ["moves.glb"] })).toEqual({ animations: [] });
  });
});
