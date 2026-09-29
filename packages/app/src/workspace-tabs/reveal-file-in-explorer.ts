import { resolveExplorerRevealPath } from "@/file-explorer/reveal";
import { useExplorerRevealStore } from "@/file-explorer/reveal-store";
import { buildWorkspaceExplorerStateKey } from "@/hooks/use-file-explorer-actions";
import {
  openExplorerSidebarView,
  usesCompactExplorerSidebar,
  type ExplorerSidebarInput,
} from "./explorer-sidebar";

export interface RevealFileInExplorerInput extends ExplorerSidebarInput {
  workspaceId: string;
  /** A file tab path: absolute, or relative to the workspace root. */
  path: string;
}

export type RevealFileInExplorerResult = "revealing" | "outside-workspace" | "unavailable";

/**
 * Shows Explorer on Files and asks its tree to expand to, select, and scroll to the file.
 * Workspace focus stays on the caller's tab. The tree never follows tab changes on its own;
 * this is the only way it moves to a file.
 */
export function revealFileInExplorer(input: RevealFileInExplorerInput): RevealFileInExplorerResult {
  const { checkout } = input;
  const workspaceStateKey = checkout
    ? buildWorkspaceExplorerStateKey({
        workspaceId: input.workspaceId,
        workspaceRoot: checkout.cwd,
      })
    : null;
  // Mirrors openExplorerSidebarView: only the desktop pane needs the layout key.
  const hasShell = usesCompactExplorerSidebar(input) || Boolean(input.workspaceKey);
  if (!checkout || !workspaceStateKey || !hasShell) {
    return "unavailable";
  }
  const path = resolveExplorerRevealPath({ path: input.path, workspaceRoot: checkout.cwd });
  if (!path) {
    return "outside-workspace";
  }
  useExplorerRevealStore.getState().requestReveal({
    serverId: checkout.serverId,
    workspaceStateKey,
    path,
  });
  openExplorerSidebarView({ ...input, view: "files" });
  return "revealing";
}
