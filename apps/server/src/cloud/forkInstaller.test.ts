// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it } from "vite-plus/test";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const opsDir = NodePath.resolve(import.meta.dirname, "../../../../ops/systemd");
const installer = NodeFS.readFileSync(NodePath.join(opsDir, "install-t3code-fork-service"), "utf8");
const packageJson = NodeFS.readFileSync(
  NodePath.resolve(import.meta.dirname, "../../../../package.json"),
  "utf8",
);
const lockHelper = NodePath.join(opsDir, "t3code-fork-lock");
const firstToken = "123e4567-e89b-42d3-a456-426614174000";
const secondToken = "987e6543-e21b-42d3-b456-426614174000";
const deadPid = 2_147_483_647;

function withStateDir(run: (stateDir: string) => void): void {
  const stateDir = NodeFS.mkdtempSync("/tmp/t3-fork-installer-lock-test-");
  try {
    run(stateDir);
  } finally {
    NodeFS.rmSync(stateDir, { recursive: true, force: true });
  }
}

function lockCommand(
  operation: "acquire" | "release",
  stateDir: string,
  pid: number,
  token: string,
) {
  const guardParent = NodePath.join(stateDir, "test-guard-root");
  if (!NodeFS.existsSync(guardParent)) {
    NodeFS.mkdirSync(guardParent, { mode: 0o700 });
  }
  return NodeChildProcess.spawnSync(lockHelper, [operation, stateDir, String(pid), token], {
    encoding: "utf8",
    env: {
      ...process.env,
      T3CODE_ALLOW_TEST_LOCK_GUARD: "1",
      T3CODE_TEST_LOCK_GUARD_PATH: NodePath.join(guardParent, "guard"),
    },
  });
}

function ownerBytes(stateDir: string): { readonly pid: string; readonly token: string } {
  const lockPath = NodePath.join(stateDir, "fork-update.lock");
  return {
    pid: NodeFS.readFileSync(NodePath.join(lockPath, "pid"), "utf8"),
    token: NodeFS.readFileSync(NodePath.join(lockPath, "token"), "utf8"),
  };
}

describe("fork service bootstrap installer", () => {
  it("uses the last-sorting override and validates effective ExecStart before nightly shutdown", () => {
    expect(NodeFS.existsSync(NodePath.join(opsDir, "t3code.service.d/zz-fork-update.conf"))).toBe(
      true,
    );
    expect(NodeFS.existsSync(NodePath.join(opsDir, "t3code.service.d/fork-update.conf"))).toBe(
      false,
    );
    expect(installer.indexOf('rm -f "$old_dropin_path"')).toBeGreaterThan(-1);
    expect(installer.indexOf("systemctl show t3code.service -p ExecStart")).toBeLessThan(
      installer.indexOf("systemctl disable --now t3code-nightly-update.timer"),
    );
  });

  it("establishes rollback before symlink and systemd mutations", () => {
    const trapIndex = installer.indexOf("trap exit_handler EXIT");
    expect(trapIndex).toBeGreaterThan(-1);
    expect(trapIndex).toBeLessThan(installer.indexOf('mv -Tf "$next_link" "$current_link"'));
    expect(trapIndex).toBeLessThan(
      installer.indexOf('install -m 0644 "$script_dir/t3code.service'),
    );
    expect(installer).toContain("backup_file current");
    expect(installer).toContain("nightly_enabled=");
    expect(installer).toContain("health_enabled=");
    expect(installer).toContain("restore_file dropin");
    expect(installer).toContain("trap signal_handler HUP INT TERM");
    expect(installer).toContain("rollback_complete=true");
    expect(installer).toContain("exit 1");
  });

  it("pins the package.json pnpm version through fixed offline Corepack", () => {
    const packageVersion = /"packageManager"\s*:\s*"pnpm@([^"]+)"/.exec(packageJson)?.[1];
    const installerVersion = /expected_pnpm_version="([^"]+)"/.exec(installer)?.[1];
    expect(packageVersion).toBe("11.10.0");
    expect(installerVersion).toBe(packageVersion);
    expect(installer).toContain('corepack_path="/usr/bin/corepack"');
    expect(installer).toContain('corepack_home="${run_home}/.cache/node/corepack"');
    expect(installer).toContain('"COREPACK_HOME=$corepack_home"');
    expect(installer).toContain('"COREPACK_ENABLE_NETWORK=0"');
    expect(installer).toContain('"COREPACK_ENABLE_PROJECT_SPEC=0"');
    expect(installer).toContain('"COREPACK_ENV_FILE=0"');
    expect(installer).toContain('node_dir="/home/codex/.local/share/pnpm/bin"');
    expect(installer).toContain('"PATH=$node_dir:/usr/bin:/bin"');
    expect(installer).toContain('passwd_entry="$(/usr/bin/getent passwd "$run_user")"');
    expect(installer).toContain('"$corepack_path" "pnpm@${expected_pnpm_version}"');
    expect(installer).not.toContain("T3CODE_PNPM_PATH");
    expect(installer).not.toContain("T3CODE_NODE_PATH");
    expect(installer).not.toContain("/home/codex/.local/bin/pnpm");
  });

  it("uses exact origin HEAD and the complete focused validation set", () => {
    expect(installer).toContain('run_as_user git -C "$repo" fetch --prune origin');
    expect(installer).toContain('[ "$commit" = "$origin_commit" ]');
    expect(installer).toContain("apps/server/src/cloud/forkHealthcheck.test.ts");
    expect(installer).toContain("apps/server/src/orchestration/UpdateMaintenanceGate.test.ts");
    expect(installer).toContain("apps/server/src/orchestration/Layers/OrchestrationEngine.test.ts");
    expect(installer).toContain("apps/web/src/components/ForkUpdateAction.test.tsx");
    expect(installer).toContain(
      "apps/web/src/components/settings/ConnectionsSettings.logic.test.ts",
    );
    expect(installer).toContain('while [ "$verified_seconds" -lt 120 ]');
  });

  it("runs the exact cached pnpm version through fixed offline Corepack", () => {
    const corepackPath = "/usr/bin/corepack";
    NodeFS.accessSync(corepackPath, NodeFS.constants.X_OK);
    const passwd = NodeChildProcess.spawnSync("getent", ["passwd", "codex"], {
      encoding: "utf8",
    });
    expect(passwd.status).toBe(0);
    const codexHome = passwd.stdout.trim().split(":")[5];
    expect(codexHome).toBe("/home/codex");
    const result = NodeChildProcess.spawnSync(corepackPath, ["pnpm@11.10.0", "--version"], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: codexHome,
        COREPACK_HOME: `${codexHome}/.cache/node/corepack`,
        COREPACK_ENABLE_NETWORK: "0",
        COREPACK_ENABLE_PROJECT_SPEC: "0",
        COREPACK_ENV_FILE: "0",
        PATH: "/home/codex/.local/share/pnpm/bin:/usr/bin:/bin",
      },
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("11.10.0");
  });

  it("preflights exact pnpm before state mutation then locks before package operations", () => {
    const preflightIndex = installer.indexOf('pnpm_version="$(run_pnpm --version)"');
    const exactCheckIndex = installer.indexOf(
      '[ "$pnpm_version" = "$expected_pnpm_version" ]',
      preflightIndex,
    );
    const stateDirectoryIndex = installer.indexOf(
      'install -d -o "$run_user" -g "$run_user" "$state_dir"',
    );
    const acquireIndex = installer.indexOf('"$lock_helper" acquire');
    expect(preflightIndex).toBeGreaterThan(-1);
    expect(exactCheckIndex).toBeGreaterThan(preflightIndex);
    expect(stateDirectoryIndex).toBeGreaterThan(exactCheckIndex);
    expect(installer.indexOf("trap early_exit_handler EXIT")).toBeLessThan(acquireIndex);
    expect(acquireIndex).toBeGreaterThan(stateDirectoryIndex);
    expect(acquireIndex).toBeLessThan(installer.indexOf("run_as_user git"));
    expect(acquireIndex).toBeLessThan(installer.indexOf('run_pnpm -C "$repo" install'));
    expect(acquireIndex).toBeLessThan(
      installer.indexOf('install -d -o "$run_user" -g "$run_user" "$releases_dir"'),
    );
    expect(installer.match(/\brun_pnpm\b/g)?.length).toBe(8);
    expect(installer).not.toMatch(/run_as_user\s+"\$[^"]*pnpm/);
    expect(installer).not.toContain("backup_file update_lock");
    expect(installer).not.toContain("restore_file update_lock");
    expect(installer).not.toContain('rm -rf "$lock_path"');
  });

  it("deploys the built server offline before publishing the immutable release", () => {
    const buildIndex = installer.indexOf('run_pnpm -C "$repo" exec vp run --filter t3 build');
    const deployIndex = installer.indexOf(
      'run_pnpm -C "$repo" --filter t3 deploy --prod --legacy --offline "$staged_package"',
    );
    const stagedPreflightIndex = installer.indexOf(
      'run_as_user "$node_path" "$staged_package/dist/bin.mjs" --version',
    );
    const sentinelIndex = installer.indexOf(
      '"$commit" "$staged_release/.t3-fork-release-complete"',
    );
    const renameIndex = installer.indexOf('mv "$staged_release" "$release_dir"');
    const finalPreflightIndex = installer.indexOf('"$node_path" "$entry" --version');
    expect(installer).toContain('staged_package="${staged_release}/node_modules/t3"');
    expect(deployIndex).toBeGreaterThan(buildIndex);
    expect(stagedPreflightIndex).toBeGreaterThan(deployIndex);
    expect(sentinelIndex).toBeGreaterThan(stagedPreflightIndex);
    expect(renameIndex).toBeGreaterThan(sentinelIndex);
    expect(finalPreflightIndex).toBeGreaterThan(renameIndex);
    expect(installer.match(/--filter t3 deploy --prod --legacy --offline/g)).toHaveLength(1);
    expect(installer).not.toContain("--filter t3 pack");
    expect(installer).not.toContain(" add --prod ");
    expect(installer).not.toContain("tarball=");
    expect(installer).not.toContain("package.json");
  });

  it("commits and disables signal rollback before releasing the verified activation", () => {
    const finalProbeIndex = installer.lastIndexOf("curl --fail --silent --show-error");
    const disableTrapsIndex = installer.indexOf("trap - EXIT HUP INT TERM", finalProbeIndex);
    const committedIndex = installer.indexOf("install_complete=true", disableTrapsIndex);
    const releaseIndex = installer.indexOf("release_update_lock", committedIndex);
    expect(disableTrapsIndex).toBeGreaterThan(
      installer.indexOf('while [ "$verified_seconds" -lt 120 ]'),
    );
    expect(committedIndex).toBeGreaterThan(disableTrapsIndex);
    expect(releaseIndex).toBeGreaterThan(committedIndex);
    expect(installer.indexOf("rollback_complete=true", disableTrapsIndex)).toBeLessThan(
      releaseIndex,
    );
    expect(installer.indexOf("refusing rollback", releaseIndex)).toBeGreaterThan(releaseIndex);
  });

  it("refuses a live second owner without changing metadata", () => {
    withStateDir((stateDir) => {
      expect(lockCommand("acquire", stateDir, process.pid, firstToken).status).toBe(0);
      const lockPath = NodePath.join(stateDir, "fork-update.lock");
      expect(NodeFS.statSync(lockPath).mode & 0o777).toBe(0o700);
      expect(NodeFS.statSync(NodePath.join(lockPath, "pid")).mode & 0o777).toBe(0o600);
      expect(NodeFS.statSync(NodePath.join(lockPath, "token")).mode & 0o777).toBe(0o600);
      expect(
        NodeFS.statSync(NodePath.join(stateDir, "test-guard-root", "guard")).mode & 0o777,
      ).toBe(0o600);
      const before = ownerBytes(stateDir);
      expect(lockCommand("acquire", stateDir, process.pid, secondToken).status).not.toBe(0);
      expect(ownerBytes(stateDir)).toEqual(before);
      expect(lockCommand("release", stateDir, process.pid, firstToken).status).toBe(0);
    });
  });

  it("recovers a conclusively dead well-formed owner", () => {
    withStateDir((stateDir) => {
      const lockPath = NodePath.join(stateDir, "fork-update.lock");
      NodeFS.mkdirSync(lockPath, { mode: 0o700 });
      NodeFS.writeFileSync(NodePath.join(lockPath, "pid"), `${String(deadPid)}\n`, {
        mode: 0o600,
      });
      NodeFS.writeFileSync(NodePath.join(lockPath, "token"), `${firstToken}\n`, {
        mode: 0o600,
      });
      expect(lockCommand("acquire", stateDir, process.pid, secondToken).status).toBe(0);
      expect(ownerBytes(stateDir)).toEqual({
        pid: `${String(process.pid)}\n`,
        token: `${secondToken}\n`,
      });
      expect(lockCommand("release", stateDir, process.pid, secondToken).status).toBe(0);
    });
  });

  it("preserves malformed and verification-protected locks byte-for-byte", () => {
    withStateDir((stateDir) => {
      const lockPath = NodePath.join(stateDir, "fork-update.lock");
      NodeFS.mkdirSync(lockPath);
      NodeFS.writeFileSync(NodePath.join(lockPath, "pid"), "malformed-pid\n");
      NodeFS.writeFileSync(NodePath.join(lockPath, "token"), "malformed-token\n");
      const before = ownerBytes(stateDir);
      expect(lockCommand("acquire", stateDir, process.pid, secondToken).status).not.toBe(0);
      expect(ownerBytes(stateDir)).toEqual(before);
    });
    withStateDir((stateDir) => {
      const lockPath = NodePath.join(stateDir, "fork-update.lock");
      NodeFS.mkdirSync(lockPath);
      NodeFS.writeFileSync(NodePath.join(lockPath, "pid"), `${String(deadPid)}\n`);
      NodeFS.writeFileSync(NodePath.join(lockPath, "token"), `${firstToken}\n`);
      const verificationPath = NodePath.join(stateDir, "fork-update-verification.json");
      NodeFS.writeFileSync(verificationPath, "verification-bytes");
      const before = ownerBytes(stateDir);
      expect(lockCommand("acquire", stateDir, process.pid, secondToken).status).not.toBe(0);
      expect(ownerBytes(stateDir)).toEqual(before);
      expect(NodeFS.readFileSync(verificationPath, "utf8")).toBe("verification-bytes");
    });
    withStateDir((stateDir) => {
      const foreignPath = NodePath.join(stateDir, "foreign-lock");
      NodeFS.mkdirSync(foreignPath);
      NodeFS.writeFileSync(NodePath.join(foreignPath, "pid"), `${String(deadPid)}\n`);
      NodeFS.writeFileSync(NodePath.join(foreignPath, "token"), `${firstToken}\n`);
      NodeFS.symlinkSync(foreignPath, NodePath.join(stateDir, "fork-update.lock"));
      const before = {
        pid: NodeFS.readFileSync(NodePath.join(foreignPath, "pid"), "utf8"),
        token: NodeFS.readFileSync(NodePath.join(foreignPath, "token"), "utf8"),
      };
      expect(lockCommand("acquire", stateDir, process.pid, secondToken).status).not.toBe(0);
      expect({
        pid: NodeFS.readFileSync(NodePath.join(foreignPath, "pid"), "utf8"),
        token: NodeFS.readFileSync(NodePath.join(foreignPath, "token"), "utf8"),
      }).toEqual(before);
    });
  });

  it("preserves a foreign token on release and removes only the exact owner", () => {
    withStateDir((stateDir) => {
      expect(lockCommand("acquire", stateDir, process.pid, firstToken).status).toBe(0);
      const before = ownerBytes(stateDir);
      expect(lockCommand("release", stateDir, process.pid, secondToken).status).not.toBe(0);
      expect(ownerBytes(stateDir)).toEqual(before);
      expect(lockCommand("release", stateDir, process.pid, firstToken).status).toBe(0);
      expect(NodeFS.existsSync(NodePath.join(stateDir, "fork-update.lock"))).toBe(false);
    });
  });

  it("rejects a symlinked guard without changing foreign bytes", () => {
    withStateDir((stateDir) => {
      const guardParent = NodePath.join(stateDir, "test-guard-root");
      NodeFS.mkdirSync(guardParent, { mode: 0o700 });
      const foreignPath = NodePath.join(stateDir, "foreign-guard");
      NodeFS.writeFileSync(foreignPath, "foreign-guard-bytes");
      NodeFS.symlinkSync(foreignPath, NodePath.join(guardParent, "guard"));
      expect(lockCommand("acquire", stateDir, process.pid, firstToken).status).not.toBe(0);
      expect(NodeFS.readFileSync(foreignPath, "utf8")).toBe("foreign-guard-bytes");
      expect(NodeFS.existsSync(NodePath.join(stateDir, "fork-update.lock"))).toBe(false);
    });
  });
});
