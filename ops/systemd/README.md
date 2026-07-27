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
that timer and service as well as both repository-owned checker pairs. The
legacy timer remains unchanged while the new availability assets are installed
disabled, the new oneshot is invoked and checked explicitly, and the deployed
release completes 120 seconds of continuous verification. Only then does the
installer enable and start `t3code-availability-healthcheck.timer`, verify it is
active, and disable the legacy timer. This gives a deliberately brief healthy
overlap but no interval without an availability watchdog. Any failure before
the transaction commits restores every recorded unit state and the prior
assets.

The server samples the authoritative projected session state every five
seconds and atomically publishes the bounded active-turn count to
`/run/t3code-watchdog/active-turn-count`. Graceful shutdown publishes zero.
The availability checker reports only telemetry written in the previous 15
seconds, so a killed or wedged publisher cannot leave a stale count in restart
logs. This sampling is independent of the health endpoint and does not change
provider-output queue behavior.
