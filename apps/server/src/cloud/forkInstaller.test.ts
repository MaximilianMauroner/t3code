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
    const execStartIndex = installer.indexOf("systemctl show t3code.service -p ExecStart");
    expect(execStartIndex).toBeLessThan(
      installer.indexOf('systemctl stop "$nightly_timer_unit"', execStartIndex),
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
    expect(installer).toContain('nightly_timer_enabled="$(read_unit_state is-enabled');
    expect(installer).toContain('nightly_service_enabled="$(read_unit_state is-enabled');
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

  it("strictly preflights the fixed nightly units and exact wants link read-only", () => {
    const preflightIndex = installer.indexOf("validate_nightly_preflight ||");
    const transactionIndex = installer.indexOf(
      "# Everything below is one reversible activation transaction.",
    );
    expect(installer).toContain('nightly_unit_dir="/etc/systemd/system"');
    expect(installer).toContain('nightly_timer_unit="t3code-nightly-update.timer"');
    expect(installer).toContain('nightly_service_unit="t3code-nightly-update.service"');
    expect(installer).toContain('nightly_wants_dir="${nightly_unit_dir}/timers.target.wants"');
    expect(installer).toContain('nightly_wants_link="${nightly_wants_dir}/${nightly_timer_unit}"');
    expect(installer).toContain('[ -d "$nightly_unit_dir" ] && [ ! -L "$nightly_unit_dir" ]');
    expect(installer).toContain('[ -d "$nightly_wants_dir" ] && [ ! -L "$nightly_wants_dir" ]');
    expect(installer).toContain('[ "$(/usr/bin/readlink "$source")" = /dev/null ]');
    expect(installer).toContain('[ "$(/usr/bin/stat -c \'%u\' "$source")" -eq 0 ]');
    expect(installer).toContain('[ "$(/usr/bin/stat -c \'%a\' "$source")" = 644 ]');
    expect(installer).toContain('case "$nightly_timer_enabled" in enabled|disabled|masked)');
    expect(installer).toContain('case "$nightly_service_enabled" in static|masked)');
    expect(installer).toContain('case "$nightly_timer_active" in active|inactive)');
    expect(installer).toContain('case "$nightly_service_active" in active|inactive)');
    expect(installer).toContain(
      '[ "$(/usr/bin/readlink "$nightly_wants_link")" = "$nightly_timer_path" ]',
    );
    expect(preflightIndex).toBeGreaterThan(installer.indexOf('"$node_path" "$entry" --version'));
    expect(preflightIndex).toBeLessThan(transactionIndex);
  });

  it("retires both nightly units inside the existing reversible transaction", () => {
    const timerBackupIndex = installer.indexOf(
      'backup_nightly_path nightly_timer "$nightly_timer_path"',
    );
    const serviceBackupIndex = installer.indexOf(
      'backup_nightly_path nightly_service "$nightly_service_path"',
    );
    const wantsBackupIndex = installer.indexOf(
      'backup_nightly_path nightly_wants "$nightly_wants_link"',
    );
    const trapIndex = installer.indexOf("trap exit_handler EXIT");
    const forwardIndex = installer.indexOf('systemctl stop "$nightly_timer_unit"', trapIndex);
    const forward = installer.slice(forwardIndex);
    expect(timerBackupIndex).toBeGreaterThan(-1);
    expect(serviceBackupIndex).toBeGreaterThan(timerBackupIndex);
    expect(wantsBackupIndex).toBeGreaterThan(serviceBackupIndex);
    expect(trapIndex).toBeGreaterThan(wantsBackupIndex);
    expect(forwardIndex).toBeGreaterThan(trapIndex);
    expect(forward).toContain('systemctl stop "$nightly_service_unit"');
    expect(forward).toContain('systemctl disable "$nightly_timer_unit"');
    expect(forward).toContain('[ ! -e "$nightly_wants_link" ] && [ ! -L "$nightly_wants_link" ]');
    expect(forward).toContain('rm -f "$nightly_timer_path"');
    expect(forward).toContain('rm -f "$nightly_service_path"');
    expect(forward).toContain('systemctl mask "$nightly_timer_unit"');
    expect(forward).toContain('systemctl mask "$nightly_service_unit"');
    expect(forward).toContain('[ "$(/usr/bin/readlink "$nightly_timer_path")" = /dev/null ]');
    expect(forward).toContain('[ "$(/usr/bin/readlink "$nightly_service_path")" = /dev/null ]');
    expect(forward).toContain('[ "$(read_unit_state is-enabled "$nightly_timer_unit")" = masked ]');
    expect(forward).toContain(
      '[ "$(read_unit_state is-enabled "$nightly_service_unit")" = masked ]',
    );
    expect(forward).toContain(
      '[ "$(read_unit_state is-active "$nightly_timer_unit")" = inactive ]',
    );
    expect(forward).toContain(
      '[ "$(read_unit_state is-active "$nightly_service_unit")" = inactive ]',
    );
    expect(forward).not.toMatch(/nightly_[^\n]*\|\| true/);
  });

  it("restores exact nightly artifacts and states without recursive deletion", () => {
    const restoreStart = installer.indexOf("restore_nightly_units() {");
    const restoreEnd = installer.indexOf("\n}\nrollback() {", restoreStart);
    const restore = installer.slice(restoreStart, restoreEnd);
    expect(restore).toContain('systemctl stop "$nightly_timer_unit"');
    expect(restore).toContain('systemctl stop "$nightly_service_unit"');
    expect(restore).toContain('systemctl unmask "$nightly_timer_unit"');
    expect(restore).toContain('systemctl unmask "$nightly_service_unit"');
    expect(restore).toContain('restore_nightly_path nightly_timer "$nightly_timer_path"');
    expect(restore).toContain('restore_nightly_path nightly_service "$nightly_service_path"');
    expect(restore).toContain('restore_nightly_path nightly_wants "$nightly_wants_link"');
    expect(restore.indexOf("systemctl daemon-reload")).toBeGreaterThan(
      restore.indexOf('restore_nightly_path nightly_wants "$nightly_wants_link"'),
    );
    expect(restore).toContain('enabled) systemctl enable "$nightly_timer_unit"');
    expect(restore).toContain('disabled) systemctl disable "$nightly_timer_unit"');
    expect(restore).toContain('active) systemctl start "$nightly_timer_unit"');
    expect(restore).toContain('active) systemctl start "$nightly_service_unit"');
    expect(restore).toContain("verify_nightly_original_state");
    expect(installer).toContain('rm -f "$target"');
    expect(installer).not.toMatch(/rm -rf ["']?\$nightly_/);
    expect(installer).not.toMatch(/rm -rf [^\n]*(?:nightly-update|timers\\.target\\.wants)/);
    expect(installer).toContain('case "$nightly_timer_enabled" in\n  enabled|disabled)');
    expect(installer).toContain("masked) : ;;");
  });

  it("preserves the root-only recovery bundle when mocked systemctl breaks rollback", () => {
    withStateDir((stateDir) => {
      const backupDir = NodePath.join(stateDir, "backup");
      const mockBin = NodePath.join(stateDir, "bin");
      const systemctlLog = NodePath.join(stateDir, "systemctl.log");
      const lockRelease = NodePath.join(stateDir, "lock-released");
      const rollbackStatus = NodePath.join(stateDir, "rollback-status");
      const harnessPath = NodePath.join(stateDir, "rollback-harness");
      NodeFS.mkdirSync(backupDir, { mode: 0o700 });
      NodeFS.mkdirSync(mockBin);

      const mockSystemctl = NodePath.join(mockBin, "systemctl");
      NodeFS.writeFileSync(
        mockSystemctl,
        [
          "#!/bin/sh",
          'printf "%s\\n" "$*" >>"$SYSTEMCTL_LOG"',
          'if [ "$1" = unmask ] && [ "${2-}" = t3code-nightly-update.service ]; then',
          "  exit 1",
          "fi",
          "exit 0",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );

      NodeFS.writeFileSync(NodePath.join(backupDir, "nightly_timer"), "timer-backup\n", {
        mode: 0o644,
      });
      NodeFS.writeFileSync(NodePath.join(backupDir, "nightly_service"), "service-backup\n", {
        mode: 0o644,
      });
      NodeFS.symlinkSync(
        "/etc/systemd/system/t3code-nightly-update.timer",
        NodePath.join(backupDir, "nightly_wants"),
      );
      NodeFS.writeFileSync(NodePath.join(backupDir, "current"), "previous-current\n");
      NodeFS.writeFileSync(NodePath.join(backupDir, "dropin"), "previous-dropin\n");
      for (const label of [
        "old_dropin",
        "health_script",
        "health_lock_helper",
        "health_service",
        "health_timer",
      ]) {
        NodeFS.writeFileSync(NodePath.join(backupDir, `${label}.absent`), "");
      }
      NodeFS.writeFileSync(NodePath.join(stateDir, "current"), "mutated-current\n");
      NodeFS.writeFileSync(NodePath.join(stateDir, "dropin"), "mutated-dropin\n");

      const backupHelpers = installer.slice(
        installer.indexOf("backup_file() {"),
        installer.indexOf('backup_file current "$current_link"'),
      );
      const nightlyRestoreHelpers = installer.slice(
        installer.indexOf("verify_nightly_original_state() {"),
        installer.indexOf("rollback() {"),
      );
      const rollbackFunction = installer.slice(
        installer.indexOf("rollback() {"),
        installer.indexOf("\nexit_handler() {", installer.indexOf("rollback() {")),
      );
      NodeFS.writeFileSync(
        harnessPath,
        [
          "#!/bin/sh",
          "set -u",
          backupHelpers,
          nightlyRestoreHelpers,
          rollbackFunction,
          'backup_dir="$HARNESS_ROOT/backup"',
          "nightly_backup_complete=true",
          "install_complete=false",
          "rollback_complete=false",
          'nightly_timer_unit="t3code-nightly-update.timer"',
          'nightly_service_unit="t3code-nightly-update.service"',
          'nightly_timer_path="$HARNESS_ROOT/nightly.timer"',
          'nightly_service_path="$HARNESS_ROOT/nightly.service"',
          'nightly_wants_link="$HARNESS_ROOT/nightly.wants"',
          "nightly_timer_enabled=enabled",
          "nightly_service_enabled=static",
          "nightly_timer_active=inactive",
          "nightly_service_active=inactive",
          'current_link="$HARNESS_ROOT/current"',
          'old_dropin_path="$HARNESS_ROOT/old-dropin"',
          'dropin_path="$HARNESS_ROOT/dropin"',
          'health_script="$HARNESS_ROOT/health-script"',
          'health_lock_helper="$HARNESS_ROOT/health-lock-helper"',
          'health_service="$HARNESS_ROOT/health.service"',
          'health_timer="$HARNESS_ROOT/health.timer"',
          "health_enabled=disabled",
          "health_active=inactive",
          "service_active=inactive",
          'release_update_lock() { printf "%s\\n" released >"$LOCK_RELEASE"; }',
          'if rollback; then printf "%s\\n" 0 >"$ROLLBACK_STATUS";',
          'else printf "%s\\n" "$?" >"$ROLLBACK_STATUS"; fi',
          "",
        ].join("\n"),
        { mode: 0o700 },
      );

      const result = NodeChildProcess.spawnSync("/bin/sh", [harnessPath], {
        encoding: "utf8",
        env: {
          ...process.env,
          HARNESS_ROOT: stateDir,
          LOCK_RELEASE: lockRelease,
          PATH: `${mockBin}:/usr/bin:/bin`,
          ROLLBACK_STATUS: rollbackStatus,
          SYSTEMCTL_LOG: systemctlLog,
        },
      });
      expect(result.status).toBe(0);
      expect(NodeFS.readFileSync(rollbackStatus, "utf8").trim()).toBe("1");
      expect(result.stderr).toContain(
        `Nightly updater rollback backup preserved at ${backupDir} for recovery.`,
      );
      expect(NodeFS.statSync(backupDir).mode & 0o777).toBe(0o700);
      expect(NodeFS.readFileSync(NodePath.join(backupDir, "nightly_timer"), "utf8")).toBe(
        "timer-backup\n",
      );
      expect(NodeFS.readFileSync(NodePath.join(backupDir, "nightly_service"), "utf8")).toBe(
        "service-backup\n",
      );
      expect(NodeFS.readlinkSync(NodePath.join(backupDir, "nightly_wants"))).toBe(
        "/etc/systemd/system/t3code-nightly-update.timer",
      );
      expect(NodeFS.readFileSync(NodePath.join(stateDir, "current"), "utf8")).toBe(
        "previous-current\n",
      );
      expect(NodeFS.readFileSync(NodePath.join(stateDir, "dropin"), "utf8")).toBe(
        "previous-dropin\n",
      );
      expect(NodeFS.readFileSync(lockRelease, "utf8")).toBe("released\n");
      expect(NodeFS.readFileSync(systemctlLog, "utf8")).toContain(
        "unmask t3code-nightly-update.service",
      );
    });
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
