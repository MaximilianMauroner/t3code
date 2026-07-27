// @effect-diagnostics nodeBuiltinImport:off
import { afterEach, describe, expect, it } from "vite-plus/test";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const temporaryDirectories: Array<string> = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

function executable(filePath: string, contents: string): void {
  NodeFS.writeFileSync(filePath, contents, { mode: 0o755 });
}

describe("t3code-fork-healthcheck", () => {
  it("rolls back when a healthy release fails before 120 continuous seconds", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-healthcheck-"));
    temporaryDirectories.push(root);
    const stateDir = NodePath.join(root, "state");
    const releasesDir = NodePath.join(stateDir, "fork-releases");
    const mockBin = NodePath.join(root, "bin");
    const oldRelease = NodePath.join(releasesDir, "oldcommit");
    const newRelease = NodePath.join(releasesDir, "newcommit");
    const currentLink = NodePath.join(stateDir, "fork-current");
    const healthState = NodePath.join(root, "health");
    const timeState = NodePath.join(root, "time");
    const systemctlLog = NodePath.join(root, "systemctl.log");
    const failureFile = NodePath.join(root, "failures");
    const watchdogRuntimeDir = NodePath.join(root, "watchdog");
    NodeFS.mkdirSync(oldRelease, { recursive: true });
    NodeFS.mkdirSync(newRelease, { recursive: true });
    NodeFS.mkdirSync(mockBin);
    NodeFS.mkdirSync(watchdogRuntimeDir);
    NodeFS.writeFileSync(NodePath.join(watchdogRuntimeDir, "fork-checker.lock"), "");
    NodeFS.writeFileSync(NodePath.join(watchdogRuntimeDir, "authority.lock"), "");
    NodeFS.symlinkSync(newRelease, currentLink);
    NodeFS.writeFileSync(
      NodePath.join(stateDir, "fork-update-verification.json"),
      JSON.stringify({
        previousTarget: oldRelease,
        targetCommit: "newcommit",
        startupDeadlineEpochSeconds: 220,
        lockOwnerPid: process.pid,
        lockOwnerToken: "123e4567-e89b-42d3-a456-426614174000",
      }),
    );
    const lockPath = NodePath.join(stateDir, "fork-update.lock");
    NodeFS.mkdirSync(lockPath, { mode: 0o700 });
    NodeFS.writeFileSync(NodePath.join(lockPath, "pid"), `${String(process.pid)}\n`, {
      mode: 0o600,
    });
    NodeFS.writeFileSync(
      NodePath.join(lockPath, "token"),
      "123e4567-e89b-42d3-a456-426614174000\n",
      { mode: 0o600 },
    );
    NodeFS.writeFileSync(healthState, "healthy\n");
    NodeFS.writeFileSync(timeState, "100\n");
    executable(
      NodePath.join(mockBin, "curl"),
      `#!/bin/sh
if [ "$(cat "$MOCK_HEALTH_STATE")" = healthy ]; then
  printf '%s\\n' '{"forkUpdate":{"currentCommit":"newcommit"}}'
  exit 0
fi
exit 22
`,
    );
    executable(
      NodePath.join(mockBin, "date"),
      `#!/bin/sh
if [ "\${1:-}" = "+%s" ]; then cat "$MOCK_TIME_STATE"; else printf '%s\\n' "2026-07-24T00:00:00Z"; fi
`,
    );
    executable(NodePath.join(mockBin, "chown"), "#!/bin/sh\nexit 0\n");
    executable(
      NodePath.join(mockBin, "systemctl"),
      `#!/bin/sh
printf '%s\\n' "$*" >>"$MOCK_SYSTEMCTL_LOG"
`,
    );
    const scriptPath = NodePath.resolve(
      import.meta.dirname,
      "../../../../ops/systemd/t3code-fork-healthcheck",
    );
    const environment = {
      ...process.env,
      PATH: `${mockBin}:${process.env.PATH ?? ""}`,
      MOCK_HEALTH_STATE: healthState,
      MOCK_TIME_STATE: timeState,
      MOCK_SYSTEMCTL_LOG: systemctlLog,
      T3CODE_STATE_DIR: stateDir,
      T3CODE_CURRENT_LINK: currentLink,
      T3CODE_RELEASES_DIR: releasesDir,
      T3CODE_FAILURE_FILE: failureFile,
      T3CODE_LOCK_HELPER: NodePath.resolve(
        import.meta.dirname,
        "../../../../ops/systemd/t3code-fork-lock",
      ),
      T3CODE_RUN_USER: process.env.USER ?? "codex",
      T3CODE_WATCHDOG_RUNTIME_DIR: watchdogRuntimeDir,
    };

    const healthy = NodeChildProcess.spawnSync("/bin/sh", [scriptPath], { env: environment });
    expect(healthy.status).toBe(0);
    expect(NodeFS.readFileSync(NodePath.join(stateDir, "fork-update.json"), "utf8")).toContain(
      '"stage": "verifying"',
    );

    NodeFS.writeFileSync(healthState, "unhealthy\n");
    NodeFS.writeFileSync(timeState, "110\n");
    NodeFS.writeFileSync(failureFile, "2\n");
    const failed = NodeChildProcess.spawnSync("/bin/sh", [scriptPath], { env: environment });
    expect(failed.status).toBe(1);
    expect(NodeFS.readlinkSync(currentLink)).toBe(oldRelease);
    expect(NodeFS.existsSync(NodePath.join(stateDir, "fork-update-verification.json"))).toBe(false);
    expect(NodeFS.readFileSync(failureFile, "utf8")).toBe("2\n");
    expect(NodeFS.readFileSync(systemctlLog, "utf8")).toContain("restart t3code.service");
  });
});

describe("t3code-availability-healthcheck", () => {
  it("requires three failures and rechecks generation under shared authority", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-availability-"));
    temporaryDirectories.push(root);
    const runtimeDir = NodePath.join(root, "runtime");
    const mockBin = NodePath.join(root, "bin");
    const stateFile = NodePath.join(root, "availability.state");
    const systemctlLog = NodePath.join(root, "systemctl.log");
    const loggerLog = NodePath.join(root, "logger.log");
    const activeTurnCountFile = NodePath.join(runtimeDir, "active-turn-count");
    NodeFS.mkdirSync(runtimeDir);
    NodeFS.mkdirSync(mockBin);
    NodeFS.writeFileSync(NodePath.join(runtimeDir, "availability-checker.lock"), "");
    NodeFS.writeFileSync(NodePath.join(runtimeDir, "authority.lock"), "");
    NodeFS.writeFileSync(activeTurnCountFile, "2\n");
    NodeFS.utimesSync(activeTurnCountFile, 995, 995);
    executable(NodePath.join(mockBin, "curl"), "#!/bin/sh\nexit 22\n");
    executable(NodePath.join(mockBin, "date"), "#!/bin/sh\nprintf '1000\\n'\n");
    executable(
      NodePath.join(mockBin, "logger"),
      '#!/bin/sh\nprintf "%s\\n" "$*" >>"$MOCK_LOGGER_LOG"\n',
    );
    executable(
      NodePath.join(mockBin, "systemctl"),
      `#!/bin/sh
printf '%s\\n' "$*" >>"$MOCK_SYSTEMCTL_LOG"
case "$*" in
  *InvocationID*) printf 'generation-a\\n' ;;
  *ActiveEnterTimestampMonotonic*) printf '0\\n' ;;
esac
`,
    );
    const scriptPath = NodePath.resolve(
      import.meta.dirname,
      "../../../../ops/systemd/t3code-availability-healthcheck",
    );
    const env = {
      ...process.env,
      MOCK_LOGGER_LOG: loggerLog,
      PATH: `${mockBin}:${process.env.PATH ?? ""}`,
      MOCK_SYSTEMCTL_LOG: systemctlLog,
      T3CODE_ACTIVE_TURN_COUNT_FILE: activeTurnCountFile,
      T3CODE_AVAILABILITY_STATE_FILE: stateFile,
      T3CODE_UPDATE_MARKER: NodePath.join(root, "verification.json"),
      T3CODE_WATCHDOG_RUNTIME_DIR: runtimeDir,
    };

    expect(NodeChildProcess.spawnSync("/bin/sh", [scriptPath], { env }).status).toBe(1);
    expect(NodeChildProcess.spawnSync("/bin/sh", [scriptPath], { env }).status).toBe(1);
    expect(NodeFS.existsSync(systemctlLog)).toBe(true);
    expect(NodeFS.readFileSync(systemctlLog, "utf8")).not.toContain("restart");

    expect(NodeChildProcess.spawnSync("/bin/sh", [scriptPath], { env }).status).toBe(1);
    expect(NodeFS.readFileSync(systemctlLog, "utf8")).toContain("restart t3code.service");
    expect(NodeFS.readFileSync(stateFile, "utf8")).toContain("failures=0");
    expect(NodeFS.readFileSync(loggerLog, "utf8")).toContain("active_turn_count=2");

    NodeFS.utimesSync(activeTurnCountFile, 900, 900);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(NodeChildProcess.spawnSync("/bin/sh", [scriptPath], { env }).status).toBe(1);
    }
    expect(NodeFS.readFileSync(loggerLog, "utf8")).toContain("active_turn_count=0");
  });

  it("rejects a symlinked authority without touching foreign bytes", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-availability-"));
    temporaryDirectories.push(root);
    const runtimeDir = NodePath.join(root, "runtime");
    const foreign = NodePath.join(root, "foreign");
    NodeFS.mkdirSync(runtimeDir);
    NodeFS.writeFileSync(NodePath.join(runtimeDir, "availability-checker.lock"), "");
    NodeFS.writeFileSync(foreign, "foreign-bytes");
    NodeFS.symlinkSync(foreign, NodePath.join(runtimeDir, "authority.lock"));
    const scriptPath = NodePath.resolve(
      import.meta.dirname,
      "../../../../ops/systemd/t3code-availability-healthcheck",
    );
    const result = NodeChildProcess.spawnSync("/bin/sh", [scriptPath], {
      env: { ...process.env, T3CODE_WATCHDOG_RUNTIME_DIR: runtimeDir },
    });
    expect(result.status).not.toBe(0);
    expect(NodeFS.readFileSync(foreign, "utf8")).toBe("foreign-bytes");
  });

  it("fences restart when the marker, generation, or cooldown changes", () => {
    for (const mode of ["marker", "generation", "cooldown"] as const) {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), `t3-${mode}-`));
      temporaryDirectories.push(root);
      const runtimeDir = NodePath.join(root, "runtime");
      const mockBin = NodePath.join(root, "bin");
      const stateFile = NodePath.join(root, "availability.state");
      const marker = NodePath.join(root, "verification.json");
      const systemctlLog = NodePath.join(root, "systemctl.log");
      const generationCount = NodePath.join(root, "generation-count");
      const uptimeSeconds = Number.parseFloat(NodeFS.readFileSync("/proc/uptime", "utf8"));
      const activeSince = Math.max(1, Math.floor(uptimeSeconds * 1_000_000));
      NodeFS.mkdirSync(runtimeDir);
      NodeFS.mkdirSync(mockBin);
      NodeFS.writeFileSync(NodePath.join(runtimeDir, "availability-checker.lock"), "");
      NodeFS.writeFileSync(NodePath.join(runtimeDir, "authority.lock"), "");
      if (mode === "marker") NodeFS.writeFileSync(marker, "verification");
      executable(NodePath.join(mockBin, "curl"), "#!/bin/sh\nexit 22\n");
      executable(NodePath.join(mockBin, "date"), "#!/bin/sh\nprintf '1000\\n'\n");
      executable(NodePath.join(mockBin, "logger"), "#!/bin/sh\nexit 0\n");
      executable(
        NodePath.join(mockBin, "systemctl"),
        `#!/bin/sh
printf '%s\\n' "$*" >>"$MOCK_SYSTEMCTL_LOG"
case "$*" in
  *InvocationID*)
    count=0
    [ ! -f "$GENERATION_COUNT" ] || count="$(cat "$GENERATION_COUNT")"
    count=$((count + 1))
    printf '%s\\n' "$count" >"$GENERATION_COUNT"
    if [ "$WATCHDOG_MODE" = generation ] && [ "$count" -ge 4 ]; then printf 'generation-b\\n'; else printf 'generation-a\\n'; fi
    ;;
  *ActiveEnterTimestampMonotonic*) printf '%s\\n' "$ACTIVE_SINCE" ;;
esac
`,
      );
      const scriptPath = NodePath.resolve(
        import.meta.dirname,
        "../../../../ops/systemd/t3code-availability-healthcheck",
      );
      const env = {
        ...process.env,
        ACTIVE_SINCE: mode === "cooldown" ? String(activeSince) : "0",
        GENERATION_COUNT: generationCount,
        MOCK_SYSTEMCTL_LOG: systemctlLog,
        PATH: `${mockBin}:${process.env.PATH ?? ""}`,
        T3CODE_AVAILABILITY_STATE_FILE: stateFile,
        T3CODE_UPDATE_MARKER: marker,
        T3CODE_WATCHDOG_RUNTIME_DIR: runtimeDir,
        WATCHDOG_MODE: mode,
      };

      for (let attempt = 0; attempt < 3; attempt += 1) {
        expect(NodeChildProcess.spawnSync("/bin/sh", [scriptPath], { env }).status).toBe(1);
      }
      expect(NodeFS.readFileSync(systemctlLog, "utf8")).not.toContain("restart");
    }
  });
});
