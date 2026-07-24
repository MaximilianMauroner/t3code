// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it } from "vite-plus/test";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const opsDir = NodePath.resolve(import.meta.dirname, "../../../../ops/systemd");
const installer = NodeFS.readFileSync(NodePath.join(opsDir, "install-t3code-fork-service"), "utf8");
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
  return NodeChildProcess.spawnSync(lockHelper, [operation, stateDir, String(pid), token], {
    encoding: "utf8",
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

  it("uses controlled tools, exact origin HEAD, and the complete focused validation set", () => {
    expect(installer).toContain('pnpm_path="${T3CODE_PNPM_PATH:-/home/codex/.local/bin/pnpm}"');
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

  it("uses a working executable at the target host pnpm path", () => {
    const pnpmPath = "/home/codex/.local/bin/pnpm";
    NodeFS.accessSync(pnpmPath, NodeFS.constants.X_OK);
    const result = NodeChildProcess.spawnSync(pnpmPath, ["--version"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("acquires before repository or package operations and holds through verification", () => {
    const acquireIndex = installer.indexOf('"$lock_helper" acquire');
    expect(installer.indexOf("trap early_exit_handler EXIT")).toBeLessThan(acquireIndex);
    expect(acquireIndex).toBeLessThan(installer.indexOf('pnpm_version="$(run_as_user'));
    expect(acquireIndex).toBeLessThan(installer.indexOf("run_as_user git"));
    expect(installer.indexOf("release_update_lock\ninstall_complete=true")).toBeGreaterThan(
      installer.indexOf('while [ "$verified_seconds" -lt 120 ]'),
    );
    expect(installer).not.toContain("backup_file update_lock");
    expect(installer).not.toContain("restore_file update_lock");
    expect(installer).not.toContain('rm -rf "$lock_path"');
  });

  it("refuses a live second owner without changing metadata", () => {
    withStateDir((stateDir) => {
      expect(lockCommand("acquire", stateDir, process.pid, firstToken).status).toBe(0);
      const before = ownerBytes(stateDir);
      expect(lockCommand("acquire", stateDir, process.pid, secondToken).status).not.toBe(0);
      expect(ownerBytes(stateDir)).toEqual(before);
      expect(lockCommand("release", stateDir, process.pid, firstToken).status).toBe(0);
    });
  });

  it("recovers a conclusively dead well-formed owner", () => {
    withStateDir((stateDir) => {
      const lockPath = NodePath.join(stateDir, "fork-update.lock");
      NodeFS.mkdirSync(lockPath);
      NodeFS.writeFileSync(NodePath.join(lockPath, "pid"), `${String(deadPid)}\n`);
      NodeFS.writeFileSync(NodePath.join(lockPath, "token"), `${firstToken}\n`);
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
});
