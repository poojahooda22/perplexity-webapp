import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { motion } from "motion/react";

import { cn } from "@/lib/utils";

// Ported from rare-lab's rare-ds/Tabs — a Radix Tabs with a shared-`layoutId`
// motion indicator that springs/morphs between triggers as the active tab changes.
export type TabsType = "underline" | "pill";

interface TabsContextValue {
  type: TabsType;
  activeValue: string | undefined;
  tabsId: string;
}

const TabsContext = React.createContext<TabsContextValue>({
  type: "underline",
  activeValue: undefined,
  tabsId: "",
});

export interface TabsProps extends React.ComponentProps<typeof TabsPrimitive.Root> {
  /** @default 'underline' */
  type?: TabsType;
}

function Tabs({ type = "underline", className, value, defaultValue, onValueChange, ...props }: TabsProps) {
  const tabsId = React.useId();
  const [internalValue, setInternalValue] = React.useState<string | undefined>(
    value ?? (typeof defaultValue === "string" ? defaultValue : undefined),
  );
  const activeValue = value !== undefined ? value : internalValue;

  const handleValueChange = React.useCallback(
    (next: string) => {
      setInternalValue(next);
      onValueChange?.(next);
    },
    [onValueChange],
  );

  return (
    <TabsContext.Provider value={{ type, activeValue, tabsId }}>
      <TabsPrimitive.Root
        data-slot="tabs"
        className={className}
        value={value}
        defaultValue={defaultValue}
        onValueChange={handleValueChange}
        {...props}
      />
    </TabsContext.Provider>
  );
}

const listTypeClasses: Record<TabsType, string> = {
  pill: "gap-1 rounded-lg border border-border bg-card p-1",
  underline: "gap-1",
};

function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  const { type } = React.useContext(TabsContext);
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn("flex shrink-0 items-center", listTypeClasses[type], className)}
      {...props}
    />
  );
}

const triggerTypeClasses: Record<TabsType, string> = {
  pill: "h-8 rounded-md px-3 text-muted-foreground hover:text-foreground data-[state=active]:text-foreground",
  underline: "h-9 px-2 text-muted-foreground hover:text-foreground data-[state=active]:text-foreground",
};

const indicatorClasses: Record<TabsType, string> = {
  pill: "absolute inset-0 rounded-md bg-accent",
  underline: "absolute inset-x-1 -bottom-px h-0.5 rounded-full bg-foreground",
};

const MORPH_SPRING = { type: "spring" as const, stiffness: 400, damping: 35 };

function TabsTrigger({
  className,
  children,
  value,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  const { type, activeValue, tabsId } = React.useContext(TabsContext);
  const isActive = value !== undefined && value === activeValue;

  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      value={value}
      className={cn(
        "relative inline-flex items-center justify-center gap-1.5 whitespace-nowrap text-sm font-medium",
        "cursor-pointer transition-colors duration-200 select-none",
        "focus-visible:rounded-md focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
        "disabled:pointer-events-none disabled:opacity-50",
        "[&_svg]:size-4 [&_svg]:shrink-0",
        triggerTypeClasses[type],
        className,
      )}
      {...props}
    >
      {isActive && (
        <motion.div
          layoutId={`tab-indicator-${tabsId}`}
          className={indicatorClasses[type]}
          transition={MORPH_SPRING}
        />
      )}
      <span className="relative z-10 inline-flex items-center gap-1.5">{children}</span>
    </TabsPrimitive.Trigger>
  );
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn("focus-visible:outline-none", className)}
      {...props}
    />
  );
}

export { Tabs, TabsList, TabsTrigger, TabsContent };
