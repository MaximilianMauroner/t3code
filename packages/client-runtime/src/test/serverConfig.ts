import { DEFAULT_SERVER_SETTINGS, type EnvironmentId, type ServerConfig } from "@t3tools/contracts";

export function makeTestServerConfig(
  environmentId: EnvironmentId,
  options: { readonly threadRecoveryEventsV1?: true } = {},
): ServerConfig {
  return {
    environment: {
      environmentId,
      label: "Test environment",
      platform: { os: "linux", arch: "x64" },
      serverVersion: "0.0.0-test",
      capabilities: { repositoryIdentity: true, connectionProbe: true },
    },
    auth: {
      policy: "loopback-browser",
      bootstrapMethods: ["one-time-token"],
      sessionMethods: ["browser-session-cookie", "bearer-access-token"],
      sessionCookieName: "t3_session",
    },
    cwd: "/tmp/workspace",
    keybindingsConfigPath: "/tmp/workspace/keybindings.json",
    keybindings: [],
    issues: [],
    providers: [],
    availableEditors: [],
    observability: {
      logsDirectoryPath: "/tmp/logs",
      localTracingEnabled: false,
      otlpTracesEnabled: false,
      otlpMetricsEnabled: false,
    },
    settings: DEFAULT_SERVER_SETTINGS,
    ...options,
  };
}
