import type { Source } from "../types";

export interface LocalState {
  source?: Source;
  sandboxName?: string;
  workspacePath?: string;
  managedWorkspace?: boolean;
  expiresAt?: number;
}
