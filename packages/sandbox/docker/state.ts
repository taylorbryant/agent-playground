import type { Source } from "../types";

export interface DockerState {
  source?: Source;
  sandboxName?: string;
  workspacePath?: string;
  managedWorkspace?: boolean;
  expiresAt?: number;
  containerName?: string;
  portMappings?: Record<number, number>;
}
