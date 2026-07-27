import { createProviderUsageEnvironmentAtoms } from "@t3tools/client-runtime/state/provider-usage";
import { connectionAtomRuntime } from "../connection/runtime";

export const providerUsageEnvironment = createProviderUsageEnvironmentAtoms(connectionAtomRuntime);
