import { describe, expect, it } from "vite-plus/test";

import { PROJECT_IGNORED_FILES_LIMIT } from "@t3tools/contracts";

import {
  COPYABLE_FILE_MAX_BYTES,
  cloneUrlForProtocol,
  cloneUrlProtocol,
  updateIgnoredFileSelection,
} from "./addProjectToMachine";

describe("cloneUrlForProtocol", () => {
  it("switches between scp-style SSH and HTTPS", () => {
    expect(cloneUrlForProtocol("git@github.com:pingdotgg/t3code.git", "https")).toBe(
      "https://github.com/pingdotgg/t3code.git",
    );
    expect(cloneUrlForProtocol("https://github.com/pingdotgg/t3code.git", "ssh")).toBe(
      "git@github.com:pingdotgg/t3code.git",
    );
    expect(cloneUrlForProtocol("ssh://git@gitlab.com/group/sub/repo.git", "https")).toBe(
      "https://gitlab.com/group/sub/repo.git",
    );
  });

  it("keeps the URL as is for its own protocol and drops HTTPS credentials on switch", () => {
    expect(cloneUrlForProtocol("https://token@github.com/a/b.git", "https")).toBe(
      "https://token@github.com/a/b.git",
    );
    expect(cloneUrlForProtocol("https://token@github.com/a/b.git", "ssh")).toBe(
      "git@github.com:a/b.git",
    );
  });

  it("refuses rewrites that would guess wrong", () => {
    expect(cloneUrlForProtocol("ssh://git@host.example:2222/a/b.git", "https")).toBeNull();
    expect(cloneUrlForProtocol("https://host.example:8443/a/b.git", "ssh")).toBeNull();
    expect(cloneUrlForProtocol("https://host.example:8443/a/b.git", "https")).toBe(
      "https://host.example:8443/a/b.git",
    );
    expect(cloneUrlForProtocol("/srv/git/repo.git", "https")).toBeNull();
    expect(cloneUrlProtocol("file:///srv/git/repo.git")).toBeNull();
  });
});

describe("ignored file selection", () => {
  it("keeps hidden files and their sizes when selecting and clearing shown files", () => {
    const hidden = { path: "services/api/.env.local", byteLength: 42 };
    const shown = { path: "debug.log", byteLength: 8 };
    const selected = new Map([[hidden.path, hidden]]);
    const withShown = updateIgnoredFileSelection(selected, [shown], true);
    expect(Array.from(withShown.values())).toEqual([hidden, shown]);
    expect(Array.from(updateIgnoredFileSelection(withShown, [shown], false).values())).toEqual([
      hidden,
    ]);
    expect(Array.from(selected.keys())).toEqual([hidden.path]);
  });

  it("caps selection across searches and permits deselection at the cap", () => {
    const files = Array.from({ length: PROJECT_IGNORED_FILES_LIMIT + 1 }, (_, i) => ({
      path: `file-${i}.log`,
      byteLength: 1,
    }));
    const full = updateIgnoredFileSelection(new Map(), files, true);
    expect(full.size).toBe(PROJECT_IGNORED_FILES_LIMIT);
    const extra = { path: "other/.env", byteLength: 3 };
    expect(updateIgnoredFileSelection(full, [extra], true).has(extra.path)).toBe(false);
    const cleared = updateIgnoredFileSelection(full, [files[0]!], false);
    const replaced = updateIgnoredFileSelection(cleared, [extra], true);
    expect(replaced.size).toBe(PROJECT_IGNORED_FILES_LIMIT);
    expect(replaced.has(files[0]!.path)).toBe(false);
    expect(replaced.get(extra.path)).toEqual(extra);
  });

  it("does not select files above the read cap", () => {
    const atCap = { path: ".env", byteLength: COPYABLE_FILE_MAX_BYTES };
    const tooLarge = { path: "large.log", byteLength: COPYABLE_FILE_MAX_BYTES + 1 };
    expect(
      Array.from(updateIgnoredFileSelection(new Map(), [atCap, tooLarge], true).values()),
    ).toEqual([atCap]);
  });
});
