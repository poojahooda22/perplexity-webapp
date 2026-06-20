import type { User } from "@supabase/supabase-js";
import { useNavigate } from "react-router";
import {
  Check,
  ChevronsUpDown,
  CreditCard,
  LogOut,
  Moon,
  Plug,
  Settings,
  Sun,
  User as UserIcon,
} from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useTheme } from "@/components/theme-provider";
import { cn } from "@/lib/utils";

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "U";
  if (parts.length === 1) return (parts[0] ?? "U").slice(0, 2).toUpperCase();
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase();
}

export function ProfileMenu({
  user,
  onSignOut,
  collapsed = false,
}: {
  user: User;
  onSignOut: () => void;
  collapsed?: boolean;
}) {
  const { theme, setTheme } = useTheme();
  const navigate = useNavigate();

  const meta = (user.user_metadata ?? {}) as Record<string, string | undefined>;
  const email = user.email ?? "";
  const name = meta.full_name ?? meta.name ?? email.split("@")[0] ?? "User";
  const avatarUrl = meta.avatar_url ?? meta.picture;
  const initials = getInitials(name);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex w-full items-center gap-2 rounded-lg p-1.5 text-left transition-colors",
            "hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
            collapsed && "justify-center",
          )}
          aria-label={`Open user menu for ${name}`}
        >
          <Avatar className="size-7">
            <AvatarImage src={avatarUrl} alt={name} />
            <AvatarFallback>{initials}</AvatarFallback>
          </Avatar>
          {!collapsed && (
            <>
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-sidebar-foreground">
                {name}
              </span>
              <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
            </>
          )}
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent side="top" align="start" sideOffset={8} className="w-64">
        <DropdownMenuLabel className="flex items-center gap-2 py-2 font-normal">
          <Avatar className="size-8">
            <AvatarImage src={avatarUrl} alt={name} />
            <AvatarFallback>{initials}</AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{name}</div>
            {email && <div className="truncate text-xs text-muted-foreground">{email}</div>}
          </div>
        </DropdownMenuLabel>

        <DropdownMenuSeparator />

        <DropdownMenuItem>
          <UserIcon />
          Profile
        </DropdownMenuItem>
        <DropdownMenuItem>
          <Settings />
          Settings
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => navigate("/connectors")}>
          <Plug />
          Connectors
        </DropdownMenuItem>
        <DropdownMenuItem>
          <CreditCard />
          Upgrade plan
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          Appearance
        </DropdownMenuLabel>
        <DropdownMenuItem onSelect={(e) => { e.preventDefault(); setTheme("light"); }}>
          <Sun />
          Light
          {theme === "light" && <Check className="ml-auto size-4" />}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={(e) => { e.preventDefault(); setTheme("dark"); }}>
          <Moon />
          Dark
          {theme === "dark" && <Check className="ml-auto size-4" />}
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        <DropdownMenuItem variant="destructive" onSelect={onSignOut}>
          <LogOut />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
