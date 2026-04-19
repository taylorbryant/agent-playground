import type { Source } from "../types";

export interface RemoteDockerState {
  sandboxId?: string;
  sandboxHostId?: string;
  sandboxName?: string;
  workspacePath?: string;
  managedWorkspace?: boolean;
  source?: Source;
  expiresAt?: number;
  currentBranch?: string;
  portMappings?: Record<number, number>;
  portUrls?: Record<number, string>;
}
