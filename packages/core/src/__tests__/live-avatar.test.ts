/**
 * Where the Talk page's avatar file is: an absolute path as given, a bare
 * name under the instance's own avatars folder, nothing when unset.
 */
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { avatarModelPath } from "../live/avatar.js";

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
