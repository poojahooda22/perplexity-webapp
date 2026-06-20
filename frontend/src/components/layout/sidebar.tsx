import { useState } from "react";
import type { ComponentType } from "react";
import type { User } from "@supabase/supabase-js";
import {
  Bell,
  Box,
  Clock,
  Ellipsis,
  LayoutGrid,
  Monitor,
  PanelLeft,
  Pencil,
  Plug,
  Plus,
  Sparkles,
  SlidersHorizontal,
  Trash2,
  Workflow,
} from "lucide-react";

import type { ConversationSummary } from "@/lib/api";
import { cn } from "@/lib/utils";
import { LuminaMark } from "@/components/brand";
import { ProfileMenu } from "@/components/profile-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type IconType = ComponentType<{ className?: string }>;

interface NavEntry {
  id: string;
  label: string;
  icon: IconType;
}

// const PRIMARY_NAV: NavEntry[] = [
//   { id: "computer", label: "Computer", icon: Monitor },
//   { id: "spaces", label: "Spaces", icon: LayoutGrid },
//   { id: "artifacts", label: "Artifacts", icon: Box },
//   { id: "customize", label: "Customize", icon: SlidersHorizontal },
// ];

const SECONDARY_NAV: NavEntry[] = [
  { id: "connectors", label: "Connectors", icon: Plug },
  { id: "skills", label: "Skills", icon: Sparkles },
  { id: "workflows", label: "Workflows", icon: Workflow },
];

interface SidebarProps {
  user: User;
  conversations: ConversationSummary[];
  loadingConversations: boolean;
  activeConversationId: string | null;
  onNewChat: () => void;
  onSelectConversation: (id: string) => void;
  onRenameConversation: (id: string, title: string) => void;
  onDeleteConversation: (id: string) => void;
  onSignOut: () => void;
}

function NavRow({
  icon: Icon,
  label,
  active,
  collapsed,
  onClick,
}: {
  icon: IconType;
  label: string;
  active?: boolean;
  collapsed: boolean;
  onClick?: () => void;
}) {
  const button = (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
        "focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
        active
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
        collapsed && "justify-center px-0",
      )}
    >
      <Icon className="size-[18px] shrink-0" />
      {!collapsed && <span className="truncate">{label}</span>}
    </button>
  );

  if (!collapsed) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

export function Sidebar({
  user,
  conversations,
  loadingConversations,
  activeConversationId,
  onNewChat,
  onSelectConversation,
  onRenameConversation,
  onDeleteConversation,
  onSignOut,
}: SidebarProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  function startRename(id: string, current: string) {
    setRenamingId(id);
    setRenameValue(current);
  }
  function commitRename() {
    if (renamingId && renameValue.trim()) onRenameConversation(renamingId, renameValue.trim());
    setRenamingId(null);
    setRenameValue("");
  }
  function cancelRename() {
    setRenamingId(null);
    setRenameValue("");
  }

  return (
    <aside
      className={cn(
        "flex h-full shrink-0 flex-col border-r  border-sidebar-border bg-sidebar transition-[width] duration-200",
        collapsed ? "w-[58px]" : "w-52",
      )}
    >
      {/* Brand + collapse toggle */}
      <div className={cn("flex h-14 items-center gap-2 px-3", collapsed && "justify-center px-0")}>
        {!collapsed && (
          <div className="flex flex-1 items-center gap-2 px-1 text-foreground">
            <LuminaMark className="size-5" />
            <span className="text-sm font-semibold tracking-tight">Lumina</span>
          </div>
        )}
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <PanelLeft className="size-[18px]" />
        </button>
      </div>

      {/* New chat */}
      <div className="px-3 pb-2">
        <button
          type="button"
          onClick={onNewChat}
          className={cn(
            "flex items-center gap-3 border border-sidebar-border bg-sidebar-accent/40 text-sm font-medium text-sidebar-foreground transition-colors",
            "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
            "focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
            // Collapsed → a centered circle; expanded → a full-width pill.
            collapsed ? "mx-auto size-9 justify-center rounded-full" : "w-full rounded-lg px-3 py-2",
          )}
        >
          <Plus className="size-[18px] shrink-0" />
          {!collapsed && <span>New</span>}
        </button>
      </div>

      {/* Nav + history */}
      <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-2">
        {/* {PRIMARY_NAV.map((item) => (
          <NavRow key={item.id} icon={item.icon} label={item.label} collapsed={collapsed} />
        ))} */}

        <div className="my-2 " />

        {SECONDARY_NAV.map((item) => (
          <NavRow key={item.id} icon={item.icon} label={item.label} collapsed={collapsed} />
        ))}

        {/* History — when collapsed, show just an icon that re-expands the sidebar on click */}
        {collapsed ? (
          <NavRow icon={Clock} label="History" collapsed onClick={() => setCollapsed(false)} />
        ) : (
          <div className="pt-4">
            <div className="flex items-center gap-2 px-3 pb-3 text-sm font-medium text-muted-foreground">
              <Clock className="size-3.5" />
              History
            </div>

            {loadingConversations ? (
              <div className="space-y-1 px-1 pt-1">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="h-7 animate-pulse rounded-md bg-sidebar-accent/60" />
                ))}
              </div>
            ) : conversations.length === 0 ? (
              <p className="px-3 py-2 text-xs text-muted-foreground">No conversations yet.</p>
            ) : (
              <ul className="space-y-0.5">
                {conversations.map((c) => {
                  const isActive = activeConversationId === c.id;
                  const isRenaming = renamingId === c.id;

                  if (isRenaming) {
                    return (
                      <li key={c.id}>
                        <input
                          autoFocus
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onFocus={(e) => e.currentTarget.select()}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") { e.preventDefault(); commitRename(); }
                            else if (e.key === "Escape") { e.preventDefault(); cancelRename(); }
                          }}
                          onBlur={commitRename}
                          className="w-full rounded-lg border border-ring/60 bg-background px-3 py-1.5 text-sm text-foreground focus:outline-none"
                        />
                      </li>
                    );
                  }

                  return (
                    <li key={c.id} className="group/item relative">
                      <button
                        type="button"
                        onClick={() => onSelectConversation(c.id)}
                        title={c.title ?? "Untitled"}
                        className={cn(
                          "block w-full truncate rounded-lg py-1.5 pl-3 pr-8 text-left text-sm transition-colors",
                          "focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                          isActive
                            ? "bg-sidebar-accent text-sidebar-accent-foreground"
                            : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                        )}
                      >
                        {c.title?.trim() || "Untitled"}
                      </button>

                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            aria-label="Conversation options"
                            className={cn(
                              "absolute right-1 top-1/2 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors",
                              "hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                              "opacity-0 group-hover/item:opacity-100 data-[state=open]:opacity-100",
                            )}
                          >
                            <Ellipsis className="size-4" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          side="right"
                          align="start"
                          sideOffset={4}
                          className="w-40"
                          onCloseAutoFocus={(e) => e.preventDefault()}
                        >
                          <DropdownMenuItem onSelect={() => startRename(c.id, c.title?.trim() || "")}>
                            <Pencil />
                            Rename
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            variant="destructive"
                            onSelect={() => onDeleteConversation(c.id)}
                          >
                            <Trash2 />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </nav>

      {/* Footer: profile + notifications */}
      <div
        className={cn(
          "flex items-center gap-1 border-t border-sidebar-border p-2",
          collapsed && "flex-col",
        )}
      >
        <div className="min-w-0 flex-1">
          <ProfileMenu user={user} onSignOut={onSignOut} collapsed={collapsed} />
        </div>
        <button
          type="button"
          aria-label="Notifications"
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <Bell className="size-[18px]" />
        </button>
      </div>
    </aside>
  );
}
