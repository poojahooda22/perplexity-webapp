# Zustand Advanced Patterns

> Skill reference for the `react-typescript` skill.
> Covers store architecture, middleware composition, persistence pitfalls,
> transient/high-frequency updates, immutable updates, and TypeScript patterns.
> Zustand is Lumina's chosen library *if/when* global UI state is needed — today
> the app uses TanStack Query (server state) + useState/refs + Context. See
> `lumina-react-conventions.md` for that decision.

---

## Section 1: Zustand Store Architecture for Complex Apps

### Why Zustand

Zustand is chosen over Redux and React Context for concrete reasons:

1. **No Provider wrapping.** Zustand stores are module-scoped singletons,
   importable from any component (or non-React code) without wrapping the tree in
   a context provider — useful when state must be read outside the normal render
   path (web workers, imperative callbacks, multiple React roots).

2. **No action boilerplate.** Actions are plain functions defined inline inside
   `create()`. No action types, no reducers, no dispatch ceremony.

3. **Direct mutation syntax with immutable semantics.** With the `immer`
   middleware you write `state.scene.nodes.push(node)` but Zustand produces a
   structurally-shared immutable snapshot under the hood. Without `immer`, you
   write spread-based updates (`{ ...state, scene: { ...state.scene } }`) which
   are still far less verbose than Redux reducers.

4. **Subscriptions are selectors.** Components subscribe to exactly the state
   slice they need. No `mapStateToProps`, no `useSelector` with deep equality
   checks -- just `useStore(state => state.field)`.

### Store Shape: Flat vs Nested

Rare.lab uses a **hybrid** approach:

```
EditorState
  scene: RareSceneAST          // nested: nodes[], edges[], metadata, outputNodeId
  selectedNodeIds: Set<string>  // flat
  lastSelectedId: string | null // flat
  toolMode: ToolMode            // flat
  isDragging: boolean           // flat
  executionOrder: string[]      // flat (derived, recomputed)
```

**Rules of thumb:**

- Keep UI-transient state (selection, drag, tool mode) flat at the top level.
- Keep domain data (the scene graph) in a single nested object so it can be
  serialized, persisted, and undo/redo'd as one unit.
- Never nest deeper than 3 levels. If you find yourself writing
  `state.scene.nodes[i].properties.nested.deep`, extract a helper or use Immer.

### Normalized vs Denormalized

Rare.lab stores nodes in an **array** (`scene.nodes: RareASTNode[]`) rather than
a normalized `Record<string, RareASTNode>`. This is intentional:

- The compositor iterates nodes in order -- arrays are natural.
- The node count is capped at 20 -- O(n) lookups are trivial.
- Edges are stored as a separate array with `sourceNodeId`/`targetNodeId`
  foreign keys, following a graph-edge-list pattern.

For apps with 100+ entities, prefer normalized `Record<id, Entity>` maps.

### Selector Patterns

**Atomic selectors** -- subscribe to exactly one field:

```ts
const toolMode = useEditorStore(state => state.toolMode)
```

**Computed selectors** -- derive values without storing them:

```ts
const visibleNodes = useEditorStore(
  state => state.scene.nodes.filter(n => n.visible)
)
```

**Shallow equality selectors** -- prevent re-renders when array contents
have not changed:

```ts
import { useShallow } from 'zustand/react/shallow'

const visibleNodes = useEditorStore(
  useShallow(state => state.scene.nodes.filter(n => n.visible))
)
```

**Frozen fallback selectors** -- return a stable reference when the result is
empty, avoiding infinite re-render loops:

```ts
const FALLBACK_ARRAY = Object.freeze([]) as RareASTNode[]

export const selectVisibleLayers = (state: EditorState): RareASTNode[] => {
  const visible = state.scene.nodes.filter(n => n.visible)
  return visible.length > 0 ? visible : FALLBACK_ARRAY
}
```

This pattern is used throughout `store/selectors.ts` and is critical for
preventing React reconciliation storms.

### Store Composition

Rare.lab uses a **single store** rather than multiple stores:

- One store keeps undo/redo simple (temporal middleware wraps the whole store).
- Persistence partializes to `{ scene }` only -- one serialization boundary.
- If the app grows, use the **slice pattern** (functions that receive `set`/`get`
  and return a partial state object) rather than splitting into separate stores.

Multiple stores are appropriate when:
- Two subsystems have zero shared state (e.g., auth store vs editor store).
- You need independent undo histories per store.

---

## Section 2: Middleware Composition

### Middleware Stack

Rare.lab composes four middleware layers. **Order matters** -- outermost wraps
innermost:

```ts
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { temporal } from 'zundo'

export const useEditorStore = create<EditorState>()(
  temporal(                    // 1. outermost: undo/redo history
    persist(                   // 2. persistence to localStorage
      (set, get) => ({ ... }), // 3. core state + actions
      { name: 'rare-lab-editor-storage', ... }
    ),
    { limit: 50, ... }         // temporal config
  )
)
```

### persist Middleware

Persists state to `localStorage` by default. Key configuration options:

```ts
{
  name: 'rare-lab-editor-storage',  // localStorage key
  version: 5,                       // schema version for migrations

  // Only persist source-of-truth fields, not UI state or functions
  partialize: (state) => ({
    scene: state.scene
  }),

  // Custom merge for rehydration (see Section 3)
  merge: (persisted, current) => { ... },

  // Schema migrations between versions
  migrate: (persisted, version) => { ... },
}
```

**Storage backends:**
- `localStorage` -- default, synchronous, 5MB limit.
- `createJSONStorage(() => sessionStorage)` -- per-tab, cleared on close.
- `createJSONStorage(() => indexedDB adapter)` -- for large scenes (>5MB).

### temporal Middleware (Zundo)

Provides undo/redo with a configurable history stack:

```ts
{
  limit: 50,  // keep 50 history entries

  // Only track scene changes -- ignore selection, drag state
  partialize: (state) => ({
    scene: state.scene
  }),

  // Equality check to prevent duplicate entries
  equality: (past, current) => past.scene === current.scene,
}
```

**Usage:**

```ts
import { useEditorStore } from '@/store/editorStore'

// Access temporal store
const { undo, redo, clear } = useEditorStore.temporal.getState()

// In a component
const handleUndo = () => useEditorStore.temporal.getState().undo()
```

### immer Middleware

Enables mutable-syntax updates that produce immutable state. Rare.lab currently
uses manual spread updates but Immer is recommended for deeply nested mutations:

```ts
import { immer } from 'zustand/middleware/immer'

// WITHOUT immer (Rare.lab current pattern)
updateNodeProperty: (id, key, value) =>
  set((state) => ({
    scene: {
      ...state.scene,
      nodes: state.scene.nodes.map(n =>
        n.id === id
          ? { ...n, properties: { ...n.properties, [key]: value } }
          : n
      ) as ConcreteRareASTNode[],
    }
  }))

// WITH immer (cleaner for deeply nested updates)
updateNodeProperty: (id, key, value) =>
  set((state) => {
    const node = state.scene.nodes.find(n => n.id === id)
    if (node) node.properties[key] = value
  })
```

### devtools Middleware

Connects to Redux DevTools browser extension for state inspection:

```ts
import { devtools } from 'zustand/middleware'

create<EditorState>()(
  devtools(
    temporal(
      persist(
        (set, get) => ({ ... }),
        persistConfig
      ),
      temporalConfig
    ),
    { name: 'RareLab Editor', enabled: process.env.NODE_ENV === 'development' }
  )
)
```

### Middleware Stacking Order

The recommended stacking order (outermost to innermost):

```
devtools -> temporal -> persist -> immer -> core state
```

Rationale:
- `devtools` should observe everything including undo/redo.
- `temporal` wraps persist so undo/redo operates on the persisted shape.
- `persist` wraps immer so serialization sees the final immutable snapshots.
- `immer` wraps the core state creator so actions can use mutable syntax.

### TypeScript: Typing Middleware-Composed Stores

The `create<StateType>()()` double-call pattern is required for TypeScript to
correctly infer middleware-composed types:

```ts
// CORRECT: double invocation lets TS infer middleware generics
export const useEditorStore = create<EditorState>()(
  temporal(persist((set, get) => ({ ... }), config), temporalConfig)
)

// WRONG: single invocation loses middleware type info
export const useEditorStore = create<EditorState>(
  temporal(persist((set, get) => ({ ... }), config), temporalConfig)
)
```

---

## Section 3: Persist + Rehydration Pitfalls

### The Critical Bug: Stale UUID Rehydration

This is the single most important lesson from Rare.lab Zustand usage.

**The scenario:**

1. `createPristineScene()` generates fresh UUIDs for every node on each app load.
2. `executionOrder` is a derived field: an array of node IDs sorted
   topologically.
3. If `executionOrder` is persisted, rehydration restores the OLD UUIDs from
   localStorage.
4. But the running scene has NEW UUIDs from `createPristineScene()`.
5. The compositor iterates `executionOrder`, finds no matching nodes, and
   renders nothing. Black screen.

**The fix:**

NEVER persist derived state. Persist source-of-truth only and recompute
derived fields during rehydration using the `merge()` function:

```ts
merge: (persistedState, currentState) => {
  const mergedScene =
    (persistedState as { scene?: RareSceneAST })?.scene ?? currentState.scene

  return {
    ...currentState,
    // Spread persisted source-of-truth fields
    ...(persistedState && typeof persistedState === 'object'
      ? persistedState
      : {}),
    // Override with merged scene
    scene: mergedScene,
    // CRITICAL: recompute derived fields from merged scene
    executionOrder: recomputeExecutionOrder(mergedScene),
  }
},
```

### The Rule

> Never persist derived state. Persist source-of-truth only, recompute on load.

Derived fields include:
- `executionOrder` (computed from `scene.nodes` + `scene.edges`)
- `selectedNodeIds` (UI-transient, not persisted)
- Any cached/memoized computation

### merge() Function Pattern

The `merge()` function runs once during rehydration. Its contract:

```ts
merge: (
  persistedState: unknown,     // raw JSON from storage (may be corrupt)
  currentState: EditorState    // freshly initialized state from create()
) => EditorState               // the final hydrated state
```

**Best practices:**

1. Always use `currentState` as the base (spread first).
2. Defensively check `persistedState` exists and is an object.
3. After merging source-of-truth fields, recompute ALL derived fields.
4. Never trust `persistedState` types -- always cast and validate.

### Schema Migration

When the state shape changes between versions, use the `migrate` function:

```ts
migrate: (persistedState: unknown, version: number) => {
  const state = persistedState as Record<string, unknown>

  if (version < 3) {
    // v3: grain speed changed from frame-count to seconds
    // Walk nodes and convert property values
  }

  if (version < 4) {
    // v4: added edges array for node-based architecture
    if (!state.scene || !(state.scene as any).edges) {
      (state.scene as any).edges = []
    }
  }

  return state as EditorState
},
```

### Testing Rehydration

Manual verification steps:
1. Clear localStorage: `localStorage.removeItem('rare-lab-editor-storage')`
2. Reload the app.
3. Verify the scene renders correctly (no stale references).
4. Modify the scene, reload again.
5. Verify persisted changes survived and derived fields are correct.

Automated test pattern:

```ts
it('rehydration recomputes executionOrder', () => {
  const staleState = { scene: { ...mockScene, nodes: [{ id: 'old-uuid' }] } }
  const freshState = createInitialState() // has new UUIDs

  const merged = mergeFunction(staleState, freshState)

  // executionOrder must reference IDs from the merged scene, not stale ones
  for (const id of merged.executionOrder) {
    expect(merged.scene.nodes.some(n => n.id === id)).toBe(true)
  }
})
```

---

## Section 4: Transient & High-Frequency Updates

### The Problem

When state changes many times per second (live price ticks, pointer moves,
scroll, animation frames), every component subscribed via `useStore(selector)`
re-renders on every change. At 4–60 updates/sec that schedules a React render per
update and the UI janks.

### The Rule: capture in refs, commit on a schedule

Decouple the *receive rate* from the *render rate*. Write the firehose value into
a ref (no render), then flush to React (or the store) on a controlled cadence
(`requestAnimationFrame`, or a short interval).

```ts
// Subscribe WITHOUT causing renders — read the store imperatively.
const unsub = useStore.subscribe(
  (s) => s.fastValue,
  (v) => { bufferRef.current = v },   // ref write: no re-render
);
// A separate rAF/interval commits the buffered value to component state ~Nx/sec.
```

`useStore.subscribe` and `useStore.getState()` read the store *outside* React's
render cycle — the "transient update" pattern. Use it for the firehose; use
`useStore(selector)` for normal, render-worthy state.

> **Lumina analog (no Zustand needed today):** `useLivePrices`
> (`frontend/src/hooks/use-live-prices.ts`) does exactly this without a store —
> Supabase broadcast ticks land in a `useRef` Map (no render), and a 250ms
> `setInterval` flush merges them into the TanStack cache via `setQueryData`,
> collapsing a tick firehose to ≤4 commits/sec. If that state ever needs sharing
> across distant components, the same buffer-then-flush rule applies on a store.

### Selector isolation (atomic selectors)

Whatever the source, subscribe to the *smallest* slice so a component re-renders
only when ITS data changes:

```ts
// GOOD: atomic selector — re-renders only when this property changes
const intensity = useStore((s) => s.items.find((i) => i.id === id)?.intensity ?? 1);

// BAD: subscribes to the whole collection — re-renders on ANY change
const items = useStore((s) => s.items);
const intensity = items.find((i) => i.id === id)?.intensity;
```

For selectors that build a NEW object/array each call, wrap with `useShallow`
(`zustand/react/shallow`) so referential churn doesn't force renders:

```ts
const props = useStore(useShallow((s) => selectNodeProps(s, id)));
```

---

## Section 5: Immutable Update Patterns

### Array Operations

**Add to array:**
```ts
const newScene = {
  ...state.scene,
  nodes: [...state.scene.nodes, deepClone(newNode)] as ConcreteRareASTNode[],
}
```

**Remove from array:**
```ts
const newScene = {
  ...state.scene,
  nodes: state.scene.nodes.filter(n => n.id !== targetId) as ConcreteRareASTNode[],
  // Also remove connected edges when removing a node
  edges: state.scene.edges.filter(
    e => e.sourceNodeId !== targetId && e.targetNodeId !== targetId
  ),
}
```

**Update item in array:**
```ts
const updatedNodes = state.scene.nodes.map(node =>
  node.id === targetId
    ? { ...node, properties: { ...node.properties, [key]: value } }
    : node
) as ConcreteRareASTNode[]
```

### Map/Record Operations

**Add or update a key:**
```ts
return { ...state.properties, [key]: newValue }
```

**Remove a key (without mutation):**
```ts
const { [keyToRemove]: _, ...rest } = state.properties
return rest
```

### Nested Updates

**Two levels deep:**
```ts
return {
  ...state,
  scene: {
    ...state.scene,
    metadata: {
      ...state.scene.metadata,
      modifiedAt: new Date().toISOString(),
    },
  },
}
```

**Three levels deep -- consider Immer:**
```ts
// Without Immer (verbose but explicit)
return {
  ...state,
  scene: {
    ...state.scene,
    nodes: state.scene.nodes.map(n =>
      n.id === id
        ? { ...n, properties: { ...n.properties, nested: { ...n.properties.nested, value: 42 } } }
        : n
    ),
  },
}

// With Immer (readable)
set((state) => {
  const node = state.scene.nodes.find(n => n.id === id)
  if (node) node.properties.nested.value = 42
})
```

### Set Operations

Zustand does not auto-detect `Set` changes. Always create a new Set:

```ts
// Toggle selection
const next = new Set(state.selectedNodeIds)
if (next.has(id)) {
  next.delete(id)
} else {
  next.add(id)
}
return { selectedNodeIds: next, selectedLayerIds: next }
```

### Anti-patterns

**Accidental mutation via reference:**
```ts
// WRONG: mutates the existing node in place
const node = state.scene.nodes.find(n => n.id === id)
node.properties.intensity = 0.5  // mutation!
return { scene: state.scene }    // same reference, Zustand will not notify

// RIGHT: create new objects at every level
const updatedNodes = state.scene.nodes.map(n =>
  n.id === id
    ? { ...n, properties: { ...n.properties, intensity: 0.5 } }
    : n
)
return { scene: { ...state.scene, nodes: updatedNodes } }
```

**Deep clone everything (wasteful):**
```ts
// WRONG: destroys structural sharing, breaks undo/redo equality checks
return { scene: deepClone(state.scene) }

// RIGHT: only clone the path that changed
return { scene: { ...state.scene, nodes: [...state.scene.nodes] } }
```

---

## Section 6: TypeScript Patterns for Zustand

### Store Type Definition

Define the state interface separately from the store creation:

```ts
export interface EditorState {
  // Data
  scene: RareSceneAST
  executionOrder: readonly string[]

  // UI transient
  selectedNodeIds: ReadonlySet<string>
  toolMode: ToolMode
  isDragging: boolean

  // Actions grouped by domain
  // -- Scene actions
  addNode: (node: RareASTNode) => void
  removeNode: (id: string) => void
  updateNodeProperty: (id: string, key: string, value: unknown) => void

  // -- Selection actions
  selectLayer: (id: string | null, opts?: SelectionOpts) => void
  selectAll: () => void
  deselectAll: () => void

  // -- Graph actions
  addEdge: (src: string, srcSocket: string, tgt: string, tgtSocket: string) => void
  removeEdge: (edgeId: string) => void
}
```

Use `readonly` and `ReadonlySet` for fields that should never be mutated
outside of actions.

### Typed Selectors with ReturnType Inference

Define selectors as standalone functions for reuse and testability:

```ts
// Pure selector functions (not hooks -- usable in tests and non-React code)
export const selectSelectedNode = (state: EditorState): RareASTNode | null => {
  if (state.selectedNodeIds.size !== 1) return null
  const id = [...state.selectedNodeIds][0]
  return state.scene.nodes.find(n => n.id === id) ?? null
}

export const selectNodeById = (state: EditorState, nodeId: string): RareASTNode => {
  return state.scene.nodes.find(n => n.id === nodeId) ?? FALLBACK_NODE
}

// Usage in components
const selected = useEditorStore(selectSelectedNode)
// TypeScript infers: RareASTNode | null
```

### Discriminated Union for Action Payloads

When actions need different payload shapes:

```ts
type NodeAction =
  | { type: 'add'; node: RareASTNode }
  | { type: 'remove'; id: string }
  | { type: 'update'; id: string; key: string; value: unknown }
  | { type: 'duplicate'; id: string }

function applyNodeAction(state: EditorState, action: NodeAction): Partial<EditorState> {
  switch (action.type) {
    case 'add':
      // TS knows action.node exists here
      return { ... }
    case 'remove':
      // TS knows action.id exists here
      return { ... }
  }
}
```

### Action Type Grouping

Rare.lab groups actions by domain in the interface but defines them inline
in the store creator. For larger stores, extract action groups as slice
creators:

```ts
// slices/sceneSlice.ts
import type { StateCreator } from 'zustand'

export interface SceneSlice {
  scene: RareSceneAST
  addNode: (node: RareASTNode) => void
  removeNode: (id: string) => void
}

export const createSceneSlice: StateCreator<
  EditorState,    // full state type (for cross-slice access)
  [],             // no middleware at slice level
  [],
  SceneSlice      // this slice contribution
> = (set, get) => ({
  scene: createPristineScene(),
  addNode: (node) => set((state) => { ... }),
  removeNode: (id) => set((state) => { ... }),
})
```

### Generic Store Factories

For reusable store patterns (e.g., CRUD stores):

```ts
interface CRUDState<T extends { id: string }> {
  items: readonly T[]
  add: (item: T) => void
  remove: (id: string) => void
  update: (id: string, patch: Partial<T>) => void
}

function createCRUDStore<T extends { id: string }>(initialItems: T[] = []) {
  return create<CRUDState<T>>()((set) => ({
    items: initialItems,
    add: (item) => set((s) => ({ items: [...s.items, item] })),
    remove: (id) => set((s) => ({ items: s.items.filter(i => i.id !== id) })),
    update: (id, patch) =>
      set((s) => ({
        items: s.items.map(i => (i.id === id ? { ...i, ...patch } : i)),
      })),
  }))
}
```

### Non-Serializable State in TypeScript

`Set` and `Map` are not JSON-serializable. Zustand `persist` middleware will
silently drop them unless you provide custom serialization:

```ts
{
  storage: createJSONStorage(() => localStorage, {
    replacer: (_key, value) => {
      if (value instanceof Set) return { __type: 'Set', values: [...value] }
      if (value instanceof Map) return { __type: 'Map', entries: [...value] }
      return value
    },
    reviver: (_key, value) => {
      if (value?.__type === 'Set') return new Set(value.values)
      if (value?.__type === 'Map') return new Map(value.entries)
      return value
    },
  }),
}
```

Avoid this by excluding `Set` fields from `partialize` and only persisting
plain JSON-compatible objects.

---

## Quick Reference: Recommended Store File Layout

| File | Purpose |
|------|---------|
| `store/<feature>Store.ts` | Main store: state, actions, middleware |
| `store/selectors.ts` | Pure selector functions with frozen fallbacks |

## Checklist: Adding New State to editorStore

1. Add the field to `EditorState` interface with appropriate `readonly` modifiers.
2. Add the initial value in the `create()` body.
3. If derived, add a recomputation function (like `recomputeExecutionOrder`).
4. If persisted, add to `partialize`. If derived, EXCLUDE from `partialize`.
5. If derived, recompute in the `merge()` function during rehydration.
6. If the shape changed, bump `version` and add a `migrate` case.
7. If temporal should track it, include in the temporal `partialize`.
8. Add a typed selector in `store/selectors.ts` with a frozen fallback.
9. For high-frequency reads, subscribe transiently via `subscribe`/`getState` — never force a render per change (see Section 4).
