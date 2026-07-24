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

The application writes update state as the `codex` user. The healthcheck runs
as root so it can restart the system service, but atomically changes ownership
of status files back to `codex`. Outside an update it preserves the existing
behavior of restarting the service after three consecutive failed probes.
During an update it requires a full 120 seconds of continuously successful
probes. Release pruning happens only after that window and retains the current
and immediately previous immutable releases.
