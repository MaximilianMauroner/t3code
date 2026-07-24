// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it } from "vite-plus/test";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const opsDir = NodePath.resolve(import.meta.dirname, "../../../../ops/systemd");
const installer = NodeFS.readFileSync(NodePath.join(opsDir, "install-t3code-fork-service"), "utf8");

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

  it("checks verification and live-owner locks before packaging and activation", () => {
    const checks = Array.from(installer.matchAll(/^ensure_update_gate_clear$/gm));
    expect(checks).toHaveLength(2);
    expect(checks[0]?.index).toBeLessThan(installer.indexOf('if [ ! -f "$sentinel" ]'));
    expect(checks[1]?.index).toBeLessThan(installer.indexOf('backup_dir="$(mktemp -d)"'));
    expect(installer).toContain('kill -0 "$lock_pid"');
    expect(installer).toContain('[ -d "/proc/$lock_pid" ]');
    expect(installer).toContain('mkdir "$lock_path"');
    expect(installer).not.toContain('rm -rf "$lock_path"\ninstall -d');
  });
});
