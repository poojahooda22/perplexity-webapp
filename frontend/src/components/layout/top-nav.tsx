import { useState } from "react";
import type { ComponentType } from "react";
import { CalendarClock, FileText, Images, Link2 } from "lucide-react";

import type { ChatTab } from "@/components/chat-view";
import { ThemeToggle } from "@/components/theme-toggle";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/animated-tabs";

const SECTION_TABS = ["Discover", "Finance", "Health", "Academic", "Patents"];

const CHAT_TABS: { id: ChatTab; label: string; icon: ComponentType<{ className?: string }> }[] = [
  { id: "answer", label: "Answer", icon: FileText },
  { id: "links", label: "Links", icon: Link2 },
  { id: "images", label: "Images", icon: Images },
];

export function TopNav({
  mode = "home",
  activeTab = "answer",
  onTabChange,
}: {
  mode?: "home" | "chat";
  activeTab?: ChatTab;
  onTabChange?: (tab: ChatTab) => void;
}) {
  const [section, setSection] = useState<string>(SECTION_TABS[0] ?? "Discover");

  return (
    <header className="flex h-11.5 pt-1 shrink-0 items-center justify-between gap-4 border-b border-border/60 px-4">
      {/* Plan pill */}
      <div className="flex items-center gap-2">
        {/* <span className="rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-muted-foreground">
          Free plan
        </span>
        <button
          type="button"
          className="text-xs font-medium text-foreground/80 transition-colors hover:text-foreground focus-visible:outline-none"
        >
          Upgrade
        </button> */}
      </div>

      {/* Center: section tabs on the home page, Answer/Links/Images once a query is asked.
          Both use the rare-ds animated tabs (shared-layoutId spring indicator). */}
      {mode === "chat" ? (
        <Tabs type="underline" value={activeTab} onValueChange={(v) => onTabChange?.(v as ChatTab)}>
          <TabsList>
            {CHAT_TABS.map(({ id, label, icon: Icon }) => (
              <TabsTrigger key={id} value={id}>
                <Icon />
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      ) : (
        <Tabs type="underline" value={section} onValueChange={setSection} className="hidden md:block">
          <TabsList>
            {SECTION_TABS.map((tab) => (
              <TabsTrigger key={tab} value={tab}>
                {tab}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      )}

      {/* Right controls */}
      <div className="flex items-center gap-1">
        {mode === "home" && (
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <CalendarClock className="size-3.5" />
            Scheduled
          </button>
        )}
        <ThemeToggle />
      </div>
    </header>
  );
}
