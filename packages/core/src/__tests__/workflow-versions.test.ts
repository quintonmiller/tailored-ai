import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initDatabase } from "../db/schema.js";
import { getVersion, listVersions, recordVersion } from "../workflows/versions.js";

let db: Database.Database;

beforeEach(() => {
  db = initDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

describe("workflow versions", () => {
  it("records sequential versions per workflow", () => {
    const v1 = recordVersion(db, { workflowName: "wf", yaml: "v: 1" });
    const v2 = recordVersion(db, { workflowName: "wf", yaml: "v: 2" });
    const v3 = recordVersion(db, { workflowName: "wf", yaml: "v: 3" });
    expect(v1.version).toBe(1);
    expect(v2.version).toBe(2);
    expect(v3.version).toBe(3);
  });

  it("scopes versions per workflow name", () => {
    recordVersion(db, { workflowName: "wf_a", yaml: "a1" });
    recordVersion(db, { workflowName: "wf_b", yaml: "b1" });
    recordVersion(db, { workflowName: "wf_a", yaml: "a2" });
    expect(listVersions(db, "wf_a").map((v) => v.version)).toEqual([2, 1]);
    expect(listVersions(db, "wf_b").map((v) => v.version)).toEqual([1]);
  });

  it("prunes older versions when retention is exceeded", () => {
    for (let i = 0; i < 6; i++) {
      recordVersion(db, { workflowName: "wf", yaml: `body ${i}`, retain: 3 });
    }
    const out = listVersions(db, "wf");
    expect(out.map((v) => v.version)).toEqual([6, 5, 4]);
  });

  it("getVersion returns null for missing versions", () => {
    recordVersion(db, { workflowName: "wf", yaml: "v1" });
    expect(getVersion(db, "wf", 1)?.yaml).toBe("v1");
    expect(getVersion(db, "wf", 999)).toBeNull();
  });

  it("records optional saved_by attribution", () => {
    recordVersion(db, { workflowName: "wf", yaml: "yaml", savedBy: "restore-from-v3" });
    const v = getVersion(db, "wf", 1);
    expect(v?.saved_by).toBe("restore-from-v3");
  });
});
