# Fork update host assets

These files configure the dedicated `MaximilianMauroner/t3code` host. They are
kept in the repository so the deployment and rollback behavior is reviewable.

Run `sudo ops/systemd/install-t3code-fork-service` from a clean `main`
checkout. The idempotent installer validates both GitHub remotes, performs a
frozen install and focused verification, creates and preflights the exact
immutable release, and atomically creates `fork-current` before installing the
`ExecStart` override. A bootstrap failure therefore leaves the old service
configuration in place.

The override is deliberately named `zz-fork-update.conf` so it sorts after the
host's existing `https-proxy.conf`; the installer removes the stale
`fork-update.conf` name and verifies systemd's effective `ExecStart` before it
disables the nightly updater.

The application writes update state as the `codex` user. Host actions are
serialized by `/run/t3code-watchdog/authority.lock`, provisioned by tmpfiles as
a stable, non-symlink, root-owned file that the dedicated `t3code-watchdog`
group may lock but cannot replace. Lock order is checker-local, shared
authority, then the existing fork-update guard.

Fork verification and normal availability have separate services, locks, and
state. The fork checker owns marker completion and rollback only. The normal
availability checker uses a five-second probe, three consecutive failures, a
fresh under-lock recheck, unchanged service generation, and a 120-second
post-start cooldown before restart. Its 30-second timer is installed disabled
for an explicit later rollout. Neither checker clears the other's evidence.
