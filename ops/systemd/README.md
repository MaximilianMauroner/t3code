# Fork update host assets

These files configure the dedicated `MaximilianMauroner/t3code` host. They are
kept in the repository so the deployment and rollback behavior is reviewable.

- Copy `t3code.service.d/fork-update.conf` into
  `/etc/systemd/system/t3code.service.d/`.
- Copy `t3code-fork-healthcheck` to
  `/usr/local/sbin/t3code-fork-healthcheck` with mode `0755`.
- Copy the healthcheck service and timer into `/etc/systemd/system/`.
- Disable and mask `t3code-nightly-update.timer`.
- Reload systemd, enable `t3code-fork-healthcheck.timer`, and restart
  `t3code.service` only after an initial immutable release and the
  `fork-current` symlink exist.

The application writes update state as the `codex` user. The healthcheck runs
as root so it can restart the system service, but atomically changes ownership
of status files back to `codex`. Outside an update it preserves the existing
behavior of restarting the service after three consecutive failed probes.
