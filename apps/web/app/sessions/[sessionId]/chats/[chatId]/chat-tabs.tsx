"use client";

import { GitCompare, Pencil, Plus, X } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { useSessionLayout } from "@/app/sessions/[sessionId]/session-layout-context";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useGitPanel } from "./git-panel-context";

type ChatTabsProps = {
  activeChatId: string;
};

export function ChatTabs({
  activeChatId,
}: ChatTabsProps) {
  const { chats, createChat, switchChat, deleteChat, renameChat } =
    useSessionLayout();
  const { activeView, setActiveView, setFocusedDiffFile, changesTabDismissed, setChangesTabDismissed } = useGitPanel();

  const [renamingChatId, setRenamingChatId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deletingChatId, setDeletingChatId] = useState<string | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  const handleNewChat = () => {
    const { chat } = createChat();
    switchChat(chat.id);
  };

  const handleCloseChanges = (e: React.MouseEvent) => {
    e.stopPropagation();
    setActiveView("chat");
    setFocusedDiffFile(null);
    setChangesTabDismissed(true);
  };

  const handleStartRename = (chatId: string, currentTitle: string) => {
    setRenamingChatId(chatId);
    setRenameValue(currentTitle || "");
    // Focus happens via useEffect-like behavior after render
    setTimeout(() => renameInputRef.current?.select(), 0);
  };

  const handleFinishRename = useCallback(async () => {
    if (!renamingChatId) return;
    const trimmed = renameValue.trim();
    if (trimmed) {
      try {
        await renameChat(renamingChatId, trimmed);
      } catch (err) {
        console.error("Failed to rename chat:", err);
      }
    }
    setRenamingChatId(null);
  }, [renamingChatId, renameValue, renameChat]);

  const handleConfirmDelete = useCallback(async () => {
    if (!deletingChatId) return;
    const idToDelete = deletingChatId;
    setDeletingChatId(null);

    // If deleting the active chat, navigate away first
    if (idToDelete === activeChatId) {
      const remaining = chats.filter((c) => c.id !== idToDelete);
      if (remaining.length > 0) {
        switchChat(remaining[0].id);
      }
    }

    try {
      await deleteChat(idToDelete);
    } catch (err) {
      console.error("Failed to delete chat:", err);
    }
  }, [deletingChatId, activeChatId, chats, deleteChat, switchChat]);

  const canDelete = chats.length > 1;

  return (
    <>
      <div className="flex items-center gap-0 border-b border-border bg-muted/30 px-1">
        <div className="flex min-w-0 flex-1 items-center overflow-x-auto">
          {chats.map((chat) => {
            const isActive =
              chat.id === activeChatId && activeView === "chat";
            const isRenaming = renamingChatId === chat.id;

            return (
              <div
                key={chat.id}
                className={cn(
                  "group relative flex shrink-0 items-center border-b-2 transition-colors",
                  isActive
                    ? "border-foreground text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {isRenaming ? (
                  <input
                    ref={renameInputRef}
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={() => void handleFinishRename()}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        void handleFinishRename();
                      }
                      if (e.key === "Escape") {
                        setRenamingChatId(null);
                      }
                    }}
                    className="mx-1 my-1.5 max-w-[140px] rounded border border-border bg-background px-2 py-0.5 text-sm font-medium outline-none focus:ring-1 focus:ring-ring"
                    autoFocus
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      if (chat.id !== activeChatId) {
                        switchChat(chat.id);
                      }
                      setActiveView("chat");
                    }}
                    className="flex items-center gap-1.5 px-3 py-2.5 text-sm font-medium"
                  >
                    <span className="max-w-[120px] truncate">
                      {chat.title || "New Chat"}
                    </span>
                    {chat.hasUnread && (
                      <span className="h-1.5 w-1.5 rounded-full bg-blue-500" />
                    )}
                  </button>
                )}

                {/* Hover actions: rename + close */}
                {!isRenaming && (
                  <div className="flex items-center gap-0.5 pr-1 opacity-0 transition-opacity group-hover:opacity-100">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleStartRename(chat.id, chat.title || "");
                      }}
                      className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                      aria-label="Rename chat"
                    >
                      <Pencil className="h-3 w-3" />
                    </button>
                    {canDelete && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeletingChatId(chat.id);
                        }}
                        className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                        aria-label="Close chat"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {/* Changes tab — only shown when a diff file is opened, hidden when dismissed */}
          {!changesTabDismissed && activeView === "diff" && (
            <button
              type="button"
              onClick={() => setActiveView("diff")}
              className={cn(
                "group relative flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm font-medium transition-colors",
                activeView === "diff"
                  ? "border-foreground text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              <GitCompare className="h-3.5 w-3.5" />
              <span>Changes</span>
              {/* Close button */}
              <span
                role="button"
                tabIndex={0}
                onClick={handleCloseChanges}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    handleCloseChanges(e as unknown as React.MouseEvent);
                  }
                }}
                className="ml-0.5 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover:opacity-100"
              >
                <X className="h-3 w-3" />
              </span>
            </button>
          )}

          {/* New chat button */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={handleNewChat}
                className="ml-1 flex shrink-0 items-center justify-center rounded p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">New chat</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Delete confirmation dialog */}
      <Dialog
        open={deletingChatId !== null}
        onOpenChange={(open) => {
          if (!open) setDeletingChatId(null);
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Close chat?</DialogTitle>
            <DialogDescription>
              This will permanently delete this chat and its messages. This
              action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeletingChatId(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => void handleConfirmDelete()}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
