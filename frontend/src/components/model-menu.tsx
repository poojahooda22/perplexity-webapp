import type { ComponentType } from "react";
import { ArrowRight, Atom, Bot, Check, ChevronDown, Gem, Lock, Sparkles, Zap } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export interface ModelOption {
  id: string;
  name: string;
  icon: ComponentType<{ className?: string }>;
  badge?: "Max" | "New";
  /** Locked models are shown but not selectable (free-plan style). */
  locked?: boolean;
}

// Vercel AI Gateway `<provider>/<model>` ids. Must match the backend ALLOWED_MODELS
// allowlist, or the server silently falls back to the default.
export const MODELS: ModelOption[] = [
  { id: "anthropic/claude-sonnet-4.6", name: "Claude Sonnet 4.6", icon: Atom },
  { id: "anthropic/claude-opus-4.7", name: "Claude Opus 4.7", icon: Atom, badge: "Max" },
  { id: "anthropic/claude-haiku-4.5", name: "Claude Haiku 4.5", icon: Zap },
  { id: "google/gemini-3.1-pro-preview", name: "Gemini 3.1 Pro", icon: Gem },
  { id: "google/gemini-3-pro-preview", name: "Gemini 3 Pro", icon: Gem },
  { id: "openai/gpt-5.5", name: "GPT-5.5", icon: Sparkles },
  { id: "openai/gpt-5.5-pro", name: "GPT-5.5 Pro", icon: Sparkles },
  { id: "xai/grok-4.3", name: "Grok 4.3", icon: Bot },
];

export const DEFAULT_MODEL = "anthropic/claude-sonnet-4.6";

export function modelLabel(id: string): string {
  return MODELS.find((m) => m.id === id)?.name ?? "Model";
}

export function ModelMenu({
  value,
  onChange,
}: {
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          {modelLabel(value)}
          <ChevronDown className="size-3.5" />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" side="bottom" sideOffset={8} className="w-64 p-1.5">

        {MODELS.map((model) => {
          const Icon = model.icon;
          const selected = model.id === value;
          return (
            <DropdownMenuItem
              key={model.id}
              disabled={model.locked}
              onSelect={(e) => {
                e.preventDefault();
                if (!model.locked) onChange(model.id);
              }}
              className={cn("gap-2", selected && "bg-accent/60")}
            >
              <Icon className="size-4 text-muted-foreground" />
              <span className="flex-1">{model.name}</span>
              {model.badge && (
                <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                  {model.badge}
                </span>
              )}
              {model.locked ? (
                <Lock className="size-3.5 text-muted-foreground" />
              ) : selected ? (
                <Check className="size-4" />
              ) : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
