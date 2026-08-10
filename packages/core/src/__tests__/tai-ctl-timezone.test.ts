import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = readFileSync(fileURLToPath(new URL("../../../../scripts/tai-ctl.sh", import.meta.url)), "utf8");

describe("tai-ctl timezone environment", () => {
  it("does not inject an empty TZ into the clean child environment", () => {
    expect(script).not.toContain('"TZ=${TZ:-}"');
  });

  it("preserves TZ only when the caller explicitly set a non-empty value", () => {
    expect(script).toContain('[[ -n "${TZ:-}" ]] && clean_env+=("TZ=$TZ")');
  });
});
