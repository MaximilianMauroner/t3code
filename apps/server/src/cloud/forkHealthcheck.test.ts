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
    NodeFS.mkdirSync(oldRelease, { recursive: true });
    NodeFS.mkdirSync(newRelease, { recursive: true });
    NodeFS.mkdirSync(mockBin);
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
    expect(NodeFS.existsSync(failureFile)).toBe(false);
    expect(NodeFS.readFileSync(systemctlLog, "utf8")).toContain("restart t3code.service");
  });
});
