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
authority, then the existing fork-update guard. The runtime directory is
setgid and sticky: the service can atomically replace its own
`active-turn-count` telemetry file, while it cannot replace root-owned lock
files.

Fork verification and normal availability have separate services, locks, and
state. The fork checker owns marker completion and rollback only. The normal
availability checker uses a five-second probe, three consecutive failures, a
fresh under-lock recheck, unchanged service generation, and a 120-second
post-start cooldown before restart. Neither checker clears the other's
evidence.

The installer treats the host-only `t3code-healthcheck.timer` as the legacy
availability owner. It records the exact enabled, active, and failed states of
that timer and service as well as both repository-owned checker pairs. After
the snapshots are durable, the installer stops all three timers and all three
oneshots and waits for inactivity before replacing an asset or restarting T3
Code. This is not an unowned watchdog gap: the installer already holds the
shared authority lock and directly owns readiness plus the full 120-second
release verification.

The new availability assets remain disabled while their oneshot is invoked and
checked explicitly. The installer enables the new timer only after validation,
while the legacy timer and service are still inactive, then verifies the new
timer before releasing authority. There is therefore neither an old oneshot
during replacement nor a legacy/new availability-authority overlap.

On rollback from a legacy-owned host, the installer keeps its authority lock,
stops and runtime-masks the staged new service, restores the legacy timer and
service first, and only then retires the staged timer and restores its previous
assets and exact unit state. The temporary timer overlap is inert because the
staged service cannot execute. If exact legacy restoration fails, rollback
keeps the validated staged watchdog available, fails visibly, and preserves
the root-only recovery backup instead of creating an unowned interval. Any
successful rollback restores every recorded enabled, active, and failed state.

The server samples the authoritative projected session state every five
seconds and atomically publishes the bounded active-turn count to
`/run/t3code-watchdog/active-turn-count`. Graceful shutdown publishes zero.
The availability checker reports only telemetry written in the previous 15
seconds, so a killed or wedged publisher cannot leave a stale count in restart
logs. This sampling is independent of the health endpoint and does not change
provider-output queue behavior.
