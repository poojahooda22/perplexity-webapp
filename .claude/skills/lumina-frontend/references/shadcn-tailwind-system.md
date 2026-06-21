# The shadcn + Tailwind v4 Design System — tokens, theming, and the UI primitives

> How Lumina's UI is built: shadcn primitives in [`components/ui/*`](../../../../frontend/src/components/ui/)
> styled with **Tailwind v4 (CSS-first, no `tailwind.config.js`)** over a single set of semantic
> CSS variables ported from rare-lab, a dark-first [`ThemeProvider`](../../../../frontend/src/components/theme-provider.tsx)
> that toggles a `.dark` class (with a View-Transitions circular reveal in the toggle), the motion-driven
> [`animated-tabs`](../../../../frontend/src/components/ui/animated-tabs.tsx) + Radix
> [`accordion`](../../../../frontend/src/components/ui/accordion.tsx) (whose `acc-content` keyframes live in
> `index.css`), and the [`brand`](../../../../frontend/src/components/brand.tsx) wordmark/mark. Read this when
> adding/restyling a `ui/*` component, touching colors/dark mode, or building anything that should look
> "on-system." Sibling refs: **lumina-frontend-architecture** (the shell those primitives mount in),
> **streaming-chat-rendering** (the `react-markdown` + `@tailwindcss/typography` answer surface),
> **composer-and-attachments** (the input components that consume these primitives).

`lumina-` ref = THIS codebase; line numbers drift, so cite the live file before you change it.

---

## 1. The stack is Bun's bundler + Tailwind v4 — NOT Vite, NOT a JS config

Two facts that surprise people (the SKILL.md prose says "React/Vite" as shorthand; the truth is below):

| Belief | Reality | Where |
|--------|---------|-------|
| Vite builds the frontend | **Bun's native bundler** does. `dev` is `bun --hot src/index.ts`; prod is `bun run build.ts`. | [`frontend/package.json`](../../../../frontend/package.json) `scripts` |
| Tailwind is configured in `tailwind.config.js` | **Tailwind v4 is CSS-first.** There is no config file. Theme + tokens + plugins are declared in CSS via `@theme`, `@plugin`, `@custom-variant`. | [`frontend/styles/globals.css`](../../../../frontend/styles/globals.css) |
| Tailwind runs via PostCSS | It runs through **`bun-plugin-tailwind`** in the Bun build. | `package.json` deps |

Versions that matter: `tailwindcss ^4.1`, `tw-animate-css ^1.4` (replaces the old `tailwindcss-animate`),
`@tailwindcss/typography ^0.5`, `class-variance-authority ^0.7`, `tailwind-merge ^3.3`, `motion ^12`,
`react ^19`, Radix primitives per component. CSS entry is
[`frontend/src/index.css`](../../../../frontend/src/index.css), which `@import`s `../styles/globals.css`.

---

## 2. The token system — one palette, two themes, shadcn names

[`globals.css`](../../../../frontend/styles/globals.css) is the single source of truth for color. The
rare-lab grayscale palette is mapped onto **shadcn semantic token names** so the shadcn primitives work
unchanged. The flow has three layers:

```
:root / .dark   →   @theme inline           →   Tailwind utility
--background:#fff    --color-background:         bg-background
--foreground:#1d1d1f   var(--background)         text-foreground
(raw hex per theme)  (binds token→utility)      (what you write in JSX)
```

- `:root { … }` defines the **light** palette; `.dark { … }` overrides every var for **dark** (the default).
- `@theme inline { --color-background: var(--background); … }` is the v4 bridge that turns each CSS var into
  a Tailwind color utility. **Adding a color = add the raw var to both `:root` and `.dark`, then add a
  `--color-x: var(--x)` line inside `@theme inline`.** Skip the `@theme` line and `bg-x` won't exist.
- `--radius: 0.75rem` drives `rounded-sm/md/lg/xl` via the `--radius-*` calc block; bump one number, every
  corner follows.

Semantic tokens you will actually use (never hardcode hex — use these):

| Token utility | Role | Light → Dark |
|---|---|---|
| `bg-background` / `text-foreground` | app canvas + body text | `#fff`/`#1d1d1f` → `#131314`/`#f2f3f5` |
| `bg-card` / `text-card-foreground` | raised surfaces (cards, popovers) | `#fff` → `#1d1d1f` |
| `bg-primary` / `text-primary-foreground` | primary action (inverts per theme) | dark-on-light → light-on-dark |
| `bg-secondary` / `bg-muted` / `text-muted-foreground` | quiet fills + secondary text | `#f2f3f5` → `#2b2b2e`/`#1d1d1f` |
| `bg-accent` / `text-accent-foreground` | hover/active fills | `#f2f3f5` → `#2b2b2e` |
| `border-border` / `bg-input` / `ring-ring` | hairlines, field bg, focus ring | `#dcdce0` → `#2b2b2e`/`#3e3f42` |
| `text-destructive` | errors/negatives | `#d92d20` → `#f97066` |
| `bg-sidebar*` | the left rail's own scale | dedicated sidebar tokens |
| `chart-1..5` | data-viz steps | grayscale ramp |

Fonts are tokens too: `--font-sans` = **DM Sans**, `--font-mono` = **Geist Mono** (used via `font-sans`/
`font-mono`). The base layer `@apply font-sans` on `:root` makes DM Sans the default.

**Global base rules** (also in `globals.css`): `* { @apply border-border outline-ring/50 }` gives every
element the themed border color by default, and `body { @apply bg-background text-foreground }`. Thin
theme-aware scrollbars and a `prefers-reduced-motion` kill-switch live in `index.css`.

---

## 3. Theming + dark mode — `.dark` class, not media query

Dark mode is **class-based**, declared once: `@custom-variant dark (&:is(.dark *))` in `globals.css`. So
`dark:bg-input/50` applies only under a `.dark` ancestor. The class is owned by the provider:

- [`theme-provider.tsx`](../../../../frontend/src/components/theme-provider.tsx) — `ThemeProvider` holds
  `theme: "dark" | "light"`, persists to `localStorage["theme"]`, and `applyTheme` does the one real DOM
  mutation: `root.classList.toggle("dark", theme === "dark")`. **Default is `"dark"`** (`getInitialTheme`
  returns `"dark"` when nothing is stored or on SSR). Consume via `useTheme()` — it throws if used outside
  the provider, so the provider must wrap the app at the root.
- [`theme-toggle.tsx`](../../../../frontend/src/components/theme-toggle.tsx) — the animated toggle. It does
  NOT just call `toggleTheme`; it runs a **View Transitions circular clip-path reveal** expanding from the
  button center. The sequence is the load-bearing part: compute the button center + max radius, then
  `document.startViewTransition(apply)` where `apply` uses **`flushSync`** to set the `.dark` class +
  `setTheme` synchronously (so the transition snapshots the *new* theme), then on `transition.ready` animate
  the `::view-transition-new(root)` pseudo's `clipPath` from a 0px circle to `maxRadius`. The
  `::view-transition-*` CSS in `globals.css` disables the default cross-fade and z-stacks the new snapshot on
  top. Falls back to an instant switch when `startViewTransition` is missing or reduced-motion is set.

| Need | Do | Avoid |
|---|---|---|
| Read/set theme in a component | `const { theme, setTheme } = useTheme()` | reading `localStorage` or the `.dark` class directly |
| A theme-aware style | `dark:` variant on a Tailwind class | a JS `if (theme === 'dark')` branch on inline styles |
| Animate a theme switch from a button | reuse `<ThemeToggle />` | re-implementing the View-Transition dance |
| A non-toggle theme change (e.g. profile menu) | `setTheme("light")` (instant, no animation) | calling `startViewTransition` ad hoc — only the toggle owns that |

Note: `theme-provider` exposes `toggleTheme`, but the actual toggle button bypasses it to drive the View
Transition itself; [`profile-menu.tsx`](../../../../frontend/src/components/profile-menu.tsx) uses
`setTheme` directly for an instant switch.

---

## 4. The component conventions (the shadcn dialect this repo speaks)

Every `ui/*` primitive follows the same shape — match it exactly when adding one:

1. **`cn()` everywhere.** [`lib/utils.ts`](../../../../frontend/src/lib/utils.ts) is just
   `twMerge(clsx(inputs))` — `clsx` for conditional class lists, `tailwind-merge` so a caller's
   `className` *overrides* (not duplicates) a base class. Never template-string class names by hand.
2. **`className` is always the last merge arg** so callers win:
   `cn("base classes", variantClasses, className)`.
3. **`data-slot="<name>"`** on the root element of each primitive (`data-slot="button"`, `"card"`,
   `"tabs-trigger"`). This is shadcn's styling/targeting hook — keep it.
4. **Variants via CVA**, not prop-driven `if`s. [`button.tsx`](../../../../frontend/src/components/ui/button.tsx)
   is the canonical example: `cva(base, { variants: { variant, size }, defaultVariants })`, exported as
   `buttonVariants` so other components (or `asChild` links) can borrow the classes.
5. **`asChild` via Radix `Slot`** for polymorphism (render a button's styles on an `<a>`): see `Button`'s
   `Comp = asChild ? Slot : "button"`.
6. **Forwarded refs + Radix typing for Radix-backed primitives** (`accordion`, `select`, `tooltip`,
   `dropdown-menu`): `React.forwardRef<React.ElementRef<typeof X>, React.ComponentPropsWithoutRef<typeof X>>`
   plus a `displayName`. Plain primitives (`button`, `card`) use the simpler
   `React.ComponentProps<"div">` function-component form.
7. **Icons are `lucide-react`**, sized with `size-4` and auto-targeted via `[&_svg]:size-4` patterns in the
   base class (see `button.tsx` / `animated-tabs.tsx`).
8. **Focus rings are tokenized**: `focus-visible:ring-[3px] focus-visible:ring-ring/50` is the house style —
   reuse it, don't invent a new focus treatment.

`Button` `variant`s: `default | destructive | outline | secondary | ghost | link`. `size`s: `default | sm |
lg | icon | icon-sm | icon-lg`. `Card` is a slot family (`Card`/`CardHeader`/`CardTitle`/`CardDescription`/
`CardAction`/`CardContent`/`CardFooter`) — compose them; the header is a CSS grid that auto-places a
`CardAction` to the top-right.

### Skeleton for a new `ui/*` primitive

```tsx
import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const xVariants = cva("base classes incl. focus-visible:ring-ring/50", {
  variants: { tone: { default: "bg-card", muted: "bg-muted text-muted-foreground" } },
  defaultVariants: { tone: "default" },
});

function X({ className, tone, ...props }:
  React.ComponentProps<"div"> & VariantProps<typeof xVariants>) {
  return <div data-slot="x" className={cn(xVariants({ tone, className }))} {...props} />;
}
export { X, xVariants };
```

Imports use the **`@/` alias** (`@/lib/utils`, `@/components/...`) — defined in
[`tsconfig.json`](../../../../frontend/tsconfig.json) `paths`. This is the frontend; unlike the backend, you
do **not** add `.js` extensions to relative/aliased imports here.

---

## 5. animated-tabs — the motion indicator pattern

[`animated-tabs.tsx`](../../../../frontend/src/components/ui/animated-tabs.tsx) is a Radix `Tabs` ported from
rare-lab with a **shared-`layoutId` motion indicator** that springs between triggers as the active tab
changes. Key mechanics to preserve:

- A `TabsContext` carries `{ type, activeValue, tabsId }`; `tabsId = React.useId()` namespaces the indicator
  so multiple tab groups on a page don't fight (`layoutId={\`tab-indicator-${tabsId}\`}`).
- It supports **controlled and uncontrolled** use: `activeValue = value !== undefined ? value : internalValue`.
- Two `type`s via lookup maps (not `if`s): `"underline"` (default; an `h-0.5` `bg-foreground` bar under the
  active trigger) and `"pill"` (a rounded `bg-accent` fill). `listTypeClasses` / `triggerTypeClasses` / `indicatorClasses` hold
  the per-type Tailwind.
- The indicator is a single `motion.div` rendered **only inside the active trigger** with the shared
  `layoutId`; Motion morphs it across triggers. The spring is `MORPH_SPRING = { type:"spring", stiffness:400,
  damping:35 }`. The trigger label is wrapped in `<span className="relative z-10">` so it sits above the
  indicator.

Use this (`Tabs`/`TabsList`/`TabsTrigger`/`TabsContent`) for section/sub-tab switchers (it backs the Finance
sub-tabs and discover category rows). For full route/section navigation, that's the shell's `SECTION_TABS` in
top-nav — see **lumina-frontend-architecture**.

---

## 6. accordion — Radix + the `acc-content` keyframes

[`accordion.tsx`](../../../../frontend/src/components/ui/accordion.tsx) is a thin shadcn wrapper over
`@radix-ui/react-accordion`. The non-obvious part is **where the open/close animation lives**: the
`AccordionContent` carries the class `acc-content` and the keyframes are defined in
[`index.css`](../../../../frontend/src/index.css), not in Tailwind config:

```css
@keyframes accordion-down { from { height: 0 } to { height: var(--radix-accordion-content-height) } }
@keyframes accordion-up   { from { height: var(--radix-accordion-content-height) } to { height: 0 } }
.acc-content[data-state="open"]   { animation: accordion-down 0.22s ease-out }
.acc-content[data-state="closed"] { animation: accordion-up   0.18s ease-out }
```

Radix exposes the measured height as the `--radix-accordion-content-height` CSS var and flips `data-state`;
the keyframes animate `height` between `0` and that var. The component sets `overflow-hidden` on `Content` so
the clip is clean. Other house details: `AccordionItem` uses `border-b border-border/60 last:border-b-0`; the
`AccordionTrigger` rotates its `ChevronDown` via `[&[data-state=open]>svg]:rotate-180`. The reduced-motion
block in `index.css` disables these animations globally.

**Pitfall:** the animation is custom CSS (`acc-content`), not `tw-animate-css` utilities. If you swap in the
stock shadcn accordion expecting `data-[state=open]:animate-accordion-down`, it will jump-cut — those util
classes are not wired here. Keep the `acc-content` class + the `index.css` keyframes together.

---

## 7. brand — the only place "lumina" text is allowed to be styled

[`brand.tsx`](../../../../frontend/src/components/brand.tsx) exports two pieces:

- `LuminaMark` — an 8-point asterisk SVG drawn with `stroke="currentColor"`, so it **inherits text color
  and themes automatically** (no per-theme variant needed). Defaults to `size-5`; override via `className`.
- `LuminaWordmark` — the lowercase hero wordmark, `font-light lowercase tracking-tight text-foreground`,
  `text-5xl` → `sm:text-6xl`.

Brand rule (non-negotiable, see **brand-is-lumina** memory): the app is **Lumina**. Never render
"Perplexity" anywhere user-visible; the only place that word survives is literal API route names like
`/perplexity_ask`. For any logo/wordmark surface, use these components — don't hand-type the word or color it
with raw hex (`currentColor` + `text-foreground` is what makes it theme correctly).

---

## 8. Decision framework — "which mechanism do I reach for?"

| You want… | Use | Not |
|---|---|---|
| A color | a semantic token utility (`bg-card`, `text-muted-foreground`) | raw hex / arbitrary `bg-[#1d1d1f]` |
| A new color in the system | var in `:root` + `.dark` + a `--color-x` line in `@theme inline` | a one-off arbitrary value repeated everywhere |
| Component style variants | CVA (`cva` + `VariantProps`) | boolean props branching on inline class strings |
| Merge caller classes | `cn(base, variants, className)` (last wins) | string concatenation / template literals |
| Polymorphic element | Radix `Slot` + `asChild` | cloning children / conditional element types |
| Dark-mode-specific style | `dark:` variant (class-based) | `@media (prefers-color-scheme)` |
| Tab indicator animation | `animated-tabs` shared `layoutId` motion | manual position math / CSS transitions per tab |
| Expand/collapse | `accordion` + the `acc-content` keyframes | `max-height` transition hacks |
| Long-form prose (answers) | `@tailwindcss/typography` `prose` classes | hand-styling every `<p>`/`<li>` (see streaming-chat ref) |
| Brand logo/wordmark | `LuminaMark` / `LuminaWordmark` | typed text + custom color |

---

## 9. Anti-patterns (mark an amateur) → do instead

| ❌ Anti-pattern | ✅ Do instead |
|----------------|--------------|
| Creating a `tailwind.config.js` to add a color/font/plugin. | This is Tailwind **v4 CSS-first** — edit `@theme`/`@plugin`/`@custom-variant` in `globals.css`. A JS config is ignored. |
| Hardcoding `#1d1d1f` / `bg-[#131314]`. | Use semantic tokens (`bg-background`, `text-foreground`) so both themes + future palette swaps work. |
| Adding a CSS var to `:root` only and using `bg-myvar`. | The utility doesn't exist until you add `--color-myvar: var(--myvar)` to `@theme inline` AND define it in **both** `:root` and `.dark`. |
| Toggling dark mode with `prefers-color-scheme` or a media query. | Dark mode is the `.dark` **class** (`@custom-variant dark`); flip it via `ThemeProvider`/`setTheme`. |
| Re-implementing a theme-switch animation in a new button. | Reuse `<ThemeToggle />`; the View-Transitions + `flushSync` snapshot timing is fiddly and already correct. |
| String-concatenating class names (`"base " + (x ? "a" : "b")`). | `cn("base", x ? "a" : "b")` — `clsx` + `tailwind-merge` resolves conflicts. |
| Putting `className` first in `cn(...)`. | Put caller `className` **last** so it overrides the base. |
| Branching component styles with `if (variant === …)` blocks. | A CVA `variants` map with `defaultVariants` (see `button.tsx`). |
| Dropping the stock shadcn accordion expecting `animate-accordion-*` utils. | Keep the `acc-content` class + the `index.css` keyframes — the util classes aren't wired here. |
| Forgetting `data-slot` / `displayName` / forwarded ref on a Radix primitive. | Match the house shape (§4); shadcn tooling + targeting rely on `data-slot`. |
| Importing a new icon set. | Use `lucide-react` (`size-4`), the only icon dependency. |
| Adding `.js` extensions to frontend imports (a backend habit). | Frontend uses the `@/` alias + bundler resolution; no extensions. |
| Rendering "Perplexity" or hand-typing/coloring "lumina". | `LuminaWordmark`/`LuminaMark` with `currentColor`/`text-foreground`. |

---

## 10. "Done" checklist for a design-system change

1. **Tokenized:** no raw hex; colors are semantic utilities; any new color exists in `:root` + `.dark` +
   `@theme inline`.
2. **Both themes:** the surface looks right in light **and** dark (default is dark); `dark:` variants used,
   not media queries.
3. **House shape:** new `ui/*` primitives use `cn()`, `data-slot`, CVA for variants, `asChild`/`Slot` if
   polymorphic, forwarded ref + `displayName` if Radix-backed, `@/` imports, lucide icons, tokenized focus
   ring.
4. **Motion respects users:** any animation degrades under `prefers-reduced-motion` (the `index.css` block
   already kills CSS animations globally; JS-driven motion like the theme toggle checks the media query
   itself).
5. **Animations co-located correctly:** accordion-style keyframes go in `index.css` next to `acc-content`;
   Motion indicators use a `useId`-namespaced `layoutId`.
6. **Brand-safe:** logo/wordmark via `brand.tsx`; never "Perplexity" in UI.
7. **Builds:** `bun --hot src/index.ts` compiles and the component renders in both themes (Bun bundler +
   `bun-plugin-tailwind`, no Vite/PostCSS step to debug).
