# JavaScript Modern
---

## Source: SKILL.md

---
name: javascript-pro
description: Writes, debugs, and refactors JavaScript code using modern ES2023+ features, async/await patterns, ESM module systems, and Node.js APIs. Use when building vanilla JavaScript applications, implementing Promise-based async flows, optimising browser or Node.js performance, working with Web Workers or Fetch API, or reviewing .js/.mjs/.cjs files for correctness and best practices.
license: MIT
metadata:
  author: https://github.com/Jeffallan
  version: "1.1.0"
  domain: language
  triggers: JavaScript, ES2023, async await, Node.js, vanilla JavaScript, Web Workers, Fetch API, browser API, module system
  role: specialist
  scope: implementation
  output-format: code
  related-skills: fullstack-guardian
---

# JavaScript Pro

## When to Use This Skill

- Building vanilla JavaScript applications
- Implementing async/await patterns and Promise handling
- Working with modern module systems (ESM/CJS)
- Optimizing browser performance and memory usage
- Developing Node.js backend services
- Implementing Web Workers, Service Workers, or browser APIs

## Core Workflow

1. **Analyze requirements** — Review `package.json`, module system, Node version, browser targets; confirm `.js`/`.mjs`/`.cjs` conventions
2. **Design architecture** — Plan modules, async flows, and error handling strategies
3. **Implement** — Write ES2023+ code with proper patterns and optimisations
4. **Validate** — Run linter (`eslint --fix`); if linter fails, fix all reported issues and re-run before proceeding. Check for memory leaks with DevTools or `--inspect`, verify bundle size; if leaks are found, resolve them before continuing
5. **Test** — Write comprehensive tests with Jest achieving 85%+ coverage; if coverage falls short, add missing cases and re-run. Confirm no unhandled Promise rejections

## Reference Guide

Load detailed guidance based on context:

| Topic | Reference | Load When |
|-------|-----------|-----------|
| Modern Syntax | `references/modern-syntax.md` | ES2023+ features, optional chaining, private fields |
| Async Patterns | `references/async-patterns.md` | Promises, async/await, error handling, event loop |
| Modules | `references/modules.md` | ESM vs CJS, dynamic imports, package.json exports |
| Browser APIs | `references/browser-apis.md` | Fetch, Web Workers, Storage, IntersectionObserver |
| Node Essentials | `references/node-essentials.md` | fs/promises, streams, EventEmitter, worker threads |

## Constraints

### MUST DO
- Use ES2023+ features exclusively
- Use `X | null` or `X | undefined` patterns
- Use optional chaining (`?.`) and nullish coalescing (`??`)
- Use async/await for all asynchronous operations
- Use ESM (`import`/`export`) for new projects
- Implement proper error handling with try/catch
- Add JSDoc comments for complex functions
- Follow functional programming principles

### MUST NOT DO
- Use `var` (always use `const` or `let`)
- Use callback-based patterns (prefer Promises)
- Mix CommonJS and ESM in the same module
- Ignore memory leaks or performance issues
- Skip error handling in async functions
- Use synchronous I/O in Node.js
- Mutate function parameters
- Create blocking operations in the browser

## Key Patterns with Examples

### Async/Await Error Handling
```js
// ✅ Correct — always handle async errors explicitly
async function fetchUser(id) {
  try {
    const response = await fetch(`/api/users/${id}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (err) {
    console.error("fetchUser failed:", err);
    return null;
  }
}

// ❌ Incorrect — unhandled rejection, no null guard
async function fetchUser(id) {
  const response = await fetch(`/api/users/${id}`);
  return response.json();
}
```

### Optional Chaining & Nullish Coalescing
```js
// ✅ Correct
const city = user?.address?.city ?? "Unknown";

// ❌ Incorrect — throws if address is undefined
const city = user.address.city || "Unknown";
```

### ESM Module Structure
```js
// ✅ Correct — named exports, no default-only exports for libraries
// utils/math.mjs
export const add = (a, b) => a + b;
export const multiply = (a, b) => a * b;

// consumer.mjs
import { add } from "./utils/math.mjs";

// ❌ Incorrect — mixing require() with ESM
const { add } = require("./utils/math.mjs");
```

### Avoid var / Prefer const
```js
// ✅ Correct
const MAX_RETRIES = 3;
let attempts = 0;

// ❌ Incorrect
var MAX_RETRIES = 3;
var attempts = 0;
```

## Output Templates

When implementing JavaScript features, provide:
1. Module file with clean exports
2. Test file with comprehensive coverage
3. JSDoc documentation for public APIs
4. Brief explanation of patterns used

---

## Source: async-patterns.md

# Asynchronous Patterns

## Promise Patterns

```javascript
// Promise creation
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const fetchWithTimeout = (url, timeout = 5000) => {
  return Promise.race([
    fetch(url),
    delay(timeout).then(() => Promise.reject(new Error('Timeout')))
  ]);
};

// Promise composition
const fetchUserData = async (userId) => {
  const user = await fetch(`/api/users/${userId}`).then(r => r.json());
  const posts = await fetch(`/api/users/${userId}/posts`).then(r => r.json());
  return { user, posts };
};
```

## Async/Await Best Practices

```javascript
// Parallel execution with Promise.all
const fetchAllData = async () => {
  const [users, posts, comments] = await Promise.all([
    fetch('/api/users').then(r => r.json()),
    fetch('/api/posts').then(r => r.json()),
    fetch('/api/comments').then(r => r.json())
  ]);
  return { users, posts, comments };
};

// Sequential when order matters
const processSteps = async () => {
  const step1 = await executeStep1();
  const step2 = await executeStep2(step1);
  const step3 = await executeStep3(step2);
  return step3;
};

// Conditional parallel execution
const loadUserProfile = async (userId, includeHistory = false) => {
  const userPromise = fetchUser(userId);
  const settingsPromise = fetchSettings(userId);

  const promises = [userPromise, settingsPromise];
  if (includeHistory) {
    promises.push(fetchHistory(userId));
  }

  const [user, settings, history] = await Promise.all(promises);
  return { user, settings, history };
};
```

## Error Handling Strategies

```javascript
// Try-catch with specific error handling
const safeApiCall = async (url) => {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    return await response.json();
  } catch (error) {
    if (error.name === 'TypeError') {
      console.error('Network error:', error);
    } else if (error.name === 'SyntaxError') {
      console.error('Invalid JSON:', error);
    }
    throw error;
  }
};

// Custom error classes
class ApiError extends Error {
  constructor(status, message, data) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

const fetchApi = async (endpoint) => {
  const response = await fetch(endpoint);
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new ApiError(response.status, response.statusText, data);
  }
  return response.json();
};

// Retry logic with exponential backoff
const retryWithBackoff = async (fn, maxRetries = 3) => {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      const delay = Math.min(1000 * 2 ** i, 10000);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
};
```

## Promise Combinators

```javascript
// Promise.allSettled - wait for all, regardless of rejection
const results = await Promise.allSettled([
  fetch('/api/users'),
  fetch('/api/posts'),
  fetch('/api/invalid')
]);

results.forEach((result, index) => {
  if (result.status === 'fulfilled') {
    console.log(`Success ${index}:`, result.value);
  } else {
    console.error(`Failed ${index}:`, result.reason);
  }
});

// Promise.any - first successful result
const fastestMirror = await Promise.any([
  fetch('https://mirror1.example.com/data'),
  fetch('https://mirror2.example.com/data'),
  fetch('https://mirror3.example.com/data')
]);

// Promise.race - first settled (resolved or rejected)
const raceResult = await Promise.race([
  fetchFromCache(),
  fetchFromNetwork()
]);
```

## Async Generators

```javascript
// Async generator for pagination
async function* fetchPaginatedData(baseUrl) {
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const response = await fetch(`${baseUrl}?page=${page}`);
    const data = await response.json();

    yield data.items;

    hasMore = data.hasMore;
    page++;
  }
}

// Usage
for await (const items of fetchPaginatedData('/api/items')) {
  processItems(items);
}

// Async generator with error handling
async function* streamWithRetry(source) {
  let retries = 3;

  while (retries > 0) {
    try {
      for await (const chunk of source) {
        yield chunk;
      }
      break;
    } catch (error) {
      retries--;
      if (retries === 0) throw error;
      await delay(1000);
    }
  }
}
```

## Concurrent Queue Management

```javascript
// Limit concurrent operations
class AsyncQueue {
  #queue = [];
  #running = 0;
  #maxConcurrent;

  constructor(maxConcurrent = 3) {
    this.#maxConcurrent = maxConcurrent;
  }

  async run(fn) {
    while (this.#running >= this.#maxConcurrent) {
      await new Promise(resolve => this.#queue.push(resolve));
    }

    this.#running++;
    try {
      return await fn();
    } finally {
      this.#running--;
      const resolve = this.#queue.shift();
      if (resolve) resolve();
    }
  }
}

// Usage
const queue = new AsyncQueue(2);
const results = await Promise.all(
  urls.map(url => queue.run(() => fetch(url)))
);
```

## Event Loop Understanding

```javascript
// Microtasks vs Macrotasks
console.log('1: Synchronous');

setTimeout(() => console.log('2: Macrotask (setTimeout)'), 0);

Promise.resolve().then(() => console.log('3: Microtask (Promise)'));

queueMicrotask(() => console.log('4: Microtask (queueMicrotask)'));

console.log('5: Synchronous');

// Output order: 1, 5, 3, 4, 2

// Avoid blocking the event loop
const processLargeArray = async (items) => {
  const results = [];
  const chunkSize = 100;

  for (let i = 0; i < items.length; i += chunkSize) {
    const chunk = items.slice(i, i + chunkSize);
    results.push(...chunk.map(processItem));

    // Yield to event loop
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  return results;
};
```

## AbortController for Cancellation

```javascript
// Abort fetch requests
const controller = new AbortController();
const { signal } = controller;

setTimeout(() => controller.abort(), 5000);

try {
  const response = await fetch('/api/data', { signal });
  const data = await response.json();
} catch (error) {
  if (error.name === 'AbortError') {
    console.log('Request aborted');
  }
}

// Abort multiple operations
const multiAbort = async () => {
  const controller = new AbortController();

  try {
    const [users, posts] = await Promise.all([
      fetch('/api/users', { signal: controller.signal }),
      fetch('/api/posts', { signal: controller.signal })
    ]);
  } catch (error) {
    controller.abort();
    throw error;
  }
};
```

## Stream Processing

```javascript
// Process ReadableStream
const processStream = async (url) => {
  const response = await fetch(url);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  let result = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    result += decoder.decode(value, { stream: true });
  }

  return result;
};

// Transform streams
const transformStream = new TransformStream({
  transform(chunk, controller) {
    const transformed = chunk.toString().toUpperCase();
    controller.enqueue(transformed);
  }
});

const response = await fetch('/data');
const transformed = response.body.pipeThrough(transformStream);
```

## Quick Reference

| Pattern | Use Case | Example |
|---------|----------|---------|
| `Promise.all()` | Parallel, fail-fast | `await Promise.all([p1, p2])` |
| `Promise.allSettled()` | Parallel, all results | `await Promise.allSettled([p1, p2])` |
| `Promise.race()` | First to complete | `await Promise.race([p1, p2])` |
| `Promise.any()` | First to succeed | `await Promise.any([p1, p2])` |
| `async function*` | Async iteration | `for await (const x of gen())` |
| `AbortController` | Cancellation | `fetch(url, { signal })` |
| `queueMicrotask()` | Priority microtask | `queueMicrotask(fn)` |

---

## Source: browser-apis.md

# Browser APIs

## Fetch API

```javascript
// Basic GET request
const response = await fetch('/api/users');
const data = await response.json();

// POST with JSON
const response = await fetch('/api/users', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ name: 'John', email: 'john@example.com' })
});

// Error handling
const fetchWithErrorHandling = async (url) => {
  try {
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return await response.json();
  } catch (error) {
    if (error.name === 'TypeError') {
      console.error('Network error or CORS issue');
    }
    throw error;
  }
};

// Abort requests
const controller = new AbortController();
setTimeout(() => controller.abort(), 5000);

const response = await fetch('/api/data', {
  signal: controller.signal
});

// File upload with progress
const uploadFile = async (file) => {
  const formData = new FormData();
  formData.append('file', file);

  return fetch('/api/upload', {
    method: 'POST',
    body: formData,
  });
};
```

## Web Workers

```javascript
// main.js - Create and communicate with worker
const worker = new Worker('/worker.js');

worker.postMessage({ command: 'process', data: largeArray });

worker.onmessage = (event) => {
  console.log('Result from worker:', event.data);
};

worker.onerror = (error) => {
  console.error('Worker error:', error.message);
};

// Terminate when done
worker.terminate();

// worker.js - Worker code
self.onmessage = (event) => {
  const { command, data } = event.data;

  if (command === 'process') {
    const result = processLargeData(data);
    self.postMessage(result);
  }
};

function processLargeData(data) {
  // CPU-intensive work
  return data.map(x => x * 2).reduce((a, b) => a + b, 0);
}

// Shared Worker (shared between tabs)
const sharedWorker = new SharedWorker('/shared-worker.js');

sharedWorker.port.onmessage = (event) => {
  console.log('Shared worker message:', event.data);
};

sharedWorker.port.postMessage({ type: 'init' });
```

## Service Workers & PWA

```javascript
// Register Service Worker
if ('serviceWorker' in navigator) {
  const registration = await navigator.serviceWorker.register('/sw.js');
  console.log('SW registered:', registration);

  // Update service worker
  registration.addEventListener('updatefound', () => {
    const newWorker = registration.installing;
    newWorker.addEventListener('statechange', () => {
      if (newWorker.state === 'activated') {
        window.location.reload();
      }
    });
  });
}

// sw.js - Service Worker
const CACHE_NAME = 'v1';
const urlsToCache = ['/index.html', '/styles.css', '/app.js'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(urlsToCache);
    })
  );
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((response) => {
      // Cache hit - return response
      if (response) {
        return response;
      }

      // Clone request
      const fetchRequest = event.request.clone();

      return fetch(fetchRequest).then((response) => {
        if (!response || response.status !== 200 || response.type !== 'basic') {
          return response;
        }

        const responseToCache = response.clone();

        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, responseToCache);
        });

        return response;
      });
    })
  );
});

// Background sync
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-messages') {
    event.waitUntil(syncMessages());
  }
});
```

## Local Storage & IndexedDB

```javascript
// LocalStorage (synchronous, max 5-10MB)
localStorage.setItem('theme', 'dark');
const theme = localStorage.getItem('theme');
localStorage.removeItem('theme');
localStorage.clear();

// SessionStorage (per-tab)
sessionStorage.setItem('token', 'abc123');

// IndexedDB (asynchronous, larger storage)
const openDB = () => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('myDatabase', 1);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      const objectStore = db.createObjectStore('users', { keyPath: 'id' });
      objectStore.createIndex('email', 'email', { unique: true });
    };
  });
};

const addUser = async (user) => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['users'], 'readwrite');
    const objectStore = transaction.objectStore('users');
    const request = objectStore.add(user);

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};

const getUser = async (id) => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['users']);
    const objectStore = transaction.objectStore('users');
    const request = objectStore.get(id);

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};
```

## Intersection Observer

```javascript
// Lazy loading images
const imageObserver = new IntersectionObserver(
  (entries, observer) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        const img = entry.target;
        img.src = img.dataset.src;
        img.classList.add('loaded');
        observer.unobserve(img);
      }
    });
  },
  {
    root: null, // viewport
    rootMargin: '50px',
    threshold: 0.1
  }
);

document.querySelectorAll('img[data-src]').forEach((img) => {
  imageObserver.observe(img);
});

// Infinite scroll
const loadMoreObserver = new IntersectionObserver(
  (entries) => {
    const lastEntry = entries[0];
    if (lastEntry.isIntersecting) {
      loadMoreItems();
    }
  },
  { threshold: 1.0 }
);

const sentinel = document.querySelector('#load-more-sentinel');
loadMoreObserver.observe(sentinel);
```

## Mutation Observer

```javascript
// Watch DOM changes
const observer = new MutationObserver((mutations) => {
  mutations.forEach((mutation) => {
    if (mutation.type === 'childList') {
      console.log('Nodes added/removed:', mutation.addedNodes, mutation.removedNodes);
    } else if (mutation.type === 'attributes') {
      console.log('Attribute changed:', mutation.attributeName);
    }
  });
});

observer.observe(document.body, {
  childList: true,
  attributes: true,
  subtree: true,
  attributeOldValue: true
});

// Disconnect when done
observer.disconnect();
```

## Web Notifications

```javascript
// Request permission
const permission = await Notification.requestPermission();

if (permission === 'granted') {
  new Notification('Hello!', {
    body: 'This is a notification',
    icon: '/icon.png',
    tag: 'unique-tag',
    requireInteraction: false
  });
}

// Service Worker notifications
// sw.js
self.addEventListener('push', (event) => {
  const data = event.data.json();

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: data.icon,
      badge: '/badge.png',
      data: data.url
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.openWindow(event.notification.data)
  );
});
```

## Canvas & WebGL

```javascript
// Canvas 2D
const canvas = document.getElementById('myCanvas');
const ctx = canvas.getContext('2d');

// Draw rectangle
ctx.fillStyle = '#FF0000';
ctx.fillRect(10, 10, 100, 100);

// Draw text
ctx.font = '30px Arial';
ctx.fillText('Hello Canvas', 10, 50);

// Draw image
const img = new Image();
img.onload = () => {
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
};
img.src = '/image.png';

// WebGL basic setup
const gl = canvas.getContext('webgl2');

if (!gl) {
  console.error('WebGL2 not supported');
}

// Clear canvas
gl.clearColor(0.0, 0.0, 0.0, 1.0);
gl.clear(gl.COLOR_BUFFER_BIT);
```

## Performance APIs

```javascript
// Performance timing
const timing = performance.timing;
const loadTime = timing.loadEventEnd - timing.navigationStart;
console.log('Page load time:', loadTime);

// Performance Observer
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    console.log(`${entry.name}: ${entry.duration}ms`);
  }
});

observer.observe({ entryTypes: ['measure', 'navigation', 'resource'] });

// Custom marks and measures
performance.mark('start-fetch');
await fetch('/api/data');
performance.mark('end-fetch');
performance.measure('fetch-duration', 'start-fetch', 'end-fetch');

const measures = performance.getEntriesByType('measure');
console.log(measures);
```

## Quick Reference

| API | Use Case | Browser Support |
|-----|----------|----------------|
| Fetch | HTTP requests | Modern browsers |
| Web Workers | CPU-intensive tasks | Modern browsers |
| Service Workers | Offline, caching | Modern browsers |
| IndexedDB | Large client storage | Modern browsers |
| IntersectionObserver | Lazy loading, infinite scroll | Modern browsers |
| MutationObserver | DOM change detection | Modern browsers |
| Notifications | User alerts | Modern browsers (permission) |
| Canvas | 2D graphics | All browsers |
| WebGL | 3D graphics | Modern browsers |

---

## Source: modern-syntax.md

# Modern JavaScript Syntax (ES2023+)

## Optional Chaining and Nullish Coalescing

```javascript
// Optional chaining - safe property access
const userName = user?.profile?.name;
const firstItem = items?.[0];
const result = api?.fetchData?.();

// Nullish coalescing - default only for null/undefined
const port = config.port ?? 3000;
const name = user.name ?? 'Anonymous';

// Combining both patterns
const displayName = user?.profile?.name ?? user?.email ?? 'Guest';

// Optional chaining with delete
delete user?.temporaryData?.cache;
```

## Private Class Fields

```javascript
class BankAccount {
  // Private fields
  #balance = 0;
  #accountNumber;

  // Private method
  #validateAmount(amount) {
    if (amount <= 0) throw new Error('Invalid amount');
  }

  constructor(accountNumber, initialBalance = 0) {
    this.#accountNumber = accountNumber;
    this.#balance = initialBalance;
  }

  deposit(amount) {
    this.#validateAmount(amount);
    this.#balance += amount;
    return this.#balance;
  }

  getBalance() {
    return this.#balance;
  }
}

// Static private fields
class Config {
  static #apiKey = process.env.API_KEY;

  static getApiKey() {
    return this.#apiKey;
  }
}
```

## Top-Level Await

```javascript
// No need for async IIFE wrapper
const data = await fetch('/api/config').then(r => r.json());
const db = await connectDatabase(data.dbUrl);

// Dynamic imports with await
const module = await import(`./modules/${moduleName}.js`);

// Error handling at top level
try {
  const config = await loadConfig();
  startServer(config);
} catch (error) {
  console.error('Failed to start:', error);
  process.exit(1);
}
```

## Array Methods (Modern)

```javascript
// at() - negative indexing
const last = items.at(-1);
const secondLast = items.at(-2);

// findLast() and findLastIndex()
const lastEven = numbers.findLast(n => n % 2 === 0);
const lastIndex = numbers.findLastIndex(n => n > 10);

// toSorted(), toReversed(), toSpliced() - non-mutating
const sorted = items.toSorted((a, b) => a - b);
const reversed = items.toReversed();
const spliced = items.toSpliced(1, 2, 'new');

// with() - replace at index
const updated = items.with(2, 'newValue');

// flatMap() for transform and flatten
const nestedResults = users.flatMap(user => user.posts);
```

## Object and String Enhancements

```javascript
// Object.groupBy() - group array elements
const groupedByAge = Object.groupBy(users, user => user.age);
const groupedByStatus = Object.groupBy(orders, o => o.status);

// Object.hasOwn() - safer hasOwnProperty
if (Object.hasOwn(obj, 'key')) {
  // safer than obj.hasOwnProperty('key')
}

// String.prototype.at()
const firstChar = str.at(0);
const lastChar = str.at(-1);

// replaceAll()
const cleaned = text.replaceAll('old', 'new');
const sanitized = input.replaceAll(/[<>]/g, '');
```

## WeakRef and FinalizationRegistry

```javascript
// WeakRef - hold weak references to objects
class Cache {
  #cache = new Map();

  set(key, value) {
    this.#cache.set(key, new WeakRef(value));
  }

  get(key) {
    const ref = this.#cache.get(key);
    return ref?.deref(); // undefined if GC'd
  }
}

// FinalizationRegistry - cleanup callbacks
const registry = new FinalizationRegistry((heldValue) => {
  console.log(`Cleanup: ${heldValue}`);
  // Release resources
});

class Resource {
  constructor(id) {
    this.id = id;
    registry.register(this, id, this);
  }

  dispose() {
    registry.unregister(this);
  }
}
```

## Logical Assignment Operators

```javascript
// ||= - assign if falsy
config.timeout ||= 5000;
user.name ||= 'Anonymous';

// &&= - assign if truthy
user.profile &&= sanitize(user.profile);

// ??= - assign if nullish
options.port ??= 3000;
settings.theme ??= 'dark';
```

## Numeric Separators and BigInt

```javascript
// Numeric separators for readability
const billion = 1_000_000_000;
const bytes = 0xFF_EC_DE_5E;
const trillion = 1_000_000_000_000n;

// BigInt for large integers
const hugeNumber = 9007199254740991n;
const result = hugeNumber + 1n;
const mixed = BigInt(123) + 456n;

// BigInt operations
const divided = 10n / 3n; // 3n (truncates)
const power = 2n ** 64n;
```

## Pattern Matching (Stage 3 Proposal)

```javascript
// Using switch with enhanced patterns (when available)
function processValue(value) {
  switch (true) {
    case typeof value === 'string':
      return value.toUpperCase();
    case typeof value === 'number':
      return value * 2;
    case Array.isArray(value):
      return value.length;
    default:
      return null;
  }
}

// Object destructuring patterns
function handleResponse({ status, data, error }) {
  if (error) throw error;
  if (status === 200) return data;
  return null;
}
```

## Iterator Helpers (Stage 3)

```javascript
// When available - chaining iterator operations
const result = [1, 2, 3, 4, 5]
  .values()
  .map(x => x * 2)
  .filter(x => x > 5)
  .toArray();

// Custom iterators
const range = {
  *[Symbol.iterator]() {
    for (let i = 0; i < 10; i++) {
      yield i;
    }
  }
};

for (const num of range) {
  console.log(num);
}
```

## Temporal API (Stage 3)

```javascript
// Modern date/time handling (when available)
import { Temporal } from '@js-temporal/polyfill';

const now = Temporal.Now.instant();
const date = Temporal.PlainDate.from('2024-01-15');
const time = Temporal.PlainTime.from('14:30:00');

// Duration calculations
const duration = Temporal.Duration.from({ hours: 2, minutes: 30 });
const later = now.add(duration);

// Timezone handling
const zonedTime = now.toZonedDateTimeISO('America/New_York');
```

## Quick Reference

| Feature | ES Version | Syntax |
|---------|-----------|--------|
| Optional chaining | ES2020 | `obj?.prop` |
| Nullish coalescing | ES2020 | `value ?? default` |
| Private fields | ES2022 | `#fieldName` |
| Top-level await | ES2022 | `await import()` |
| Logical assignment | ES2021 | `x ??= y` |
| Array.at() | ES2022 | `arr.at(-1)` |
| Object.hasOwn() | ES2022 | `Object.hasOwn(obj, 'key')` |
| Array.findLast() | ES2023 | `arr.findLast(fn)` |
| toSorted() | ES2023 | `arr.toSorted()` |

---

## Source: modules.md

# Module Systems

## ES Modules (ESM)

```javascript
// Named exports
export const PI = 3.14159;
export function add(a, b) {
  return a + b;
}

export class Calculator {
  multiply(a, b) {
    return a * b;
  }
}

// Default export
export default class Database {
  async connect() {
    // implementation
  }
}

// Re-exports
export { add, multiply } from './math.js';
export * from './utils.js';
export * as helpers from './helpers.js';
```

## Import Patterns

```javascript
// Named imports
import { add, multiply } from './math.js';
import { add as addition } from './math.js';

// Default import
import Database from './database.js';

// Namespace import
import * as math from './math.js';
math.add(1, 2);

// Mixed imports
import Database, { connect, disconnect } from './database.js';

// Side-effect only import
import './polyfills.js';

// Type-only imports (for documentation)
/** @typedef {import('./types.js').User} User */
```

## Dynamic Imports

```javascript
// Basic dynamic import
const module = await import('./module.js');
module.default();

// Conditional loading
const loadFeature = async (feature) => {
  if (feature === 'advanced') {
    const { AdvancedFeature } = await import('./advanced.js');
    return new AdvancedFeature();
  }
  const { BasicFeature } = await import('./basic.js');
  return new BasicFeature();
};

// Code splitting by route
const router = {
  '/home': () => import('./pages/home.js'),
  '/about': () => import('./pages/about.js'),
  '/profile': () => import('./pages/profile.js')
};

const loadPage = async (route) => {
  const module = await router[route]();
  return module.default;
};

// Lazy loading with caching
const moduleCache = new Map();

const importWithCache = async (path) => {
  if (moduleCache.has(path)) {
    return moduleCache.get(path);
  }
  const module = await import(path);
  moduleCache.set(path, module);
  return module;
};
```

## Package.json Configuration

```json
{
  "name": "my-package",
  "version": "1.0.0",
  "type": "module",
  "main": "./dist/index.cjs",
  "module": "./dist/index.mjs",
  "exports": {
    ".": {
      "import": "./dist/index.mjs",
      "require": "./dist/index.cjs",
      "types": "./dist/index.d.ts"
    },
    "./utils": {
      "import": "./dist/utils.mjs",
      "require": "./dist/utils.cjs"
    },
    "./package.json": "./package.json"
  },
  "imports": {
    "#utils": "./src/utils/index.js",
    "#constants": "./src/constants.js"
  }
}
```

## Conditional Exports

```javascript
// package.json with conditional exports
{
  "exports": {
    ".": {
      "node": "./dist/node.js",
      "browser": "./dist/browser.js",
      "default": "./dist/index.js"
    },
    "./feature": {
      "development": "./src/feature.dev.js",
      "production": "./dist/feature.prod.js"
    }
  }
}

// Usage in code
import api from 'my-package'; // Resolves based on environment
import feature from 'my-package/feature'; // Conditional based on NODE_ENV
```

## Import Maps (Browser)

```html
<!-- In HTML -->
<script type="importmap">
{
  "imports": {
    "lodash": "/node_modules/lodash-es/lodash.js",
    "react": "https://esm.sh/react@18",
    "utils/": "/src/utils/"
  }
}
</script>

<script type="module">
import _ from 'lodash';
import React from 'react';
import { helper } from 'utils/helper.js';
</script>
```

## CommonJS Compatibility

```javascript
// ESM consuming CommonJS
import cjsModule from './commonjs-module.cjs';
import { named } from './commonjs-module.cjs'; // May not work

// Use createRequire for CommonJS in ESM
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const cjsModule = require('./commonjs-module.cjs');

// Access CommonJS metadata in ESM
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
```

## Module Resolution

```javascript
// Explicit file extensions required in ESM
import utils from './utils.js'; // Correct
import utils from './utils';    // Error in ESM

// Directory imports require index.js
import api from './api/index.js';

// Using import.meta
console.log(import.meta.url); // file:///path/to/module.js
console.log(import.meta.resolve('./other.js')); // Resolve relative path

// Detect if module is main
if (import.meta.url === `file://${process.argv[1]}`) {
  // This module was run directly
  main();
}
```

## Circular Dependencies

```javascript
// moduleA.js
import { b } from './moduleB.js';
export const a = 'A';
export function useB() {
  return b;
}

// moduleB.js
import { a } from './moduleA.js';
export const b = 'B';
export function useA() {
  return a; // Works because 'a' is hoisted
}

// Best practice: avoid circular deps, use dependency injection
// factory.js
export function createA(dependencies) {
  return {
    name: 'A',
    useB: () => dependencies.b
  };
}

export function createB(dependencies) {
  return {
    name: 'B',
    useA: () => dependencies.a
  };
}

// index.js
const a = createA({});
const b = createB({});
a.dependencies = { b };
b.dependencies = { a };
```

## Tree Shaking Optimization

```javascript
// Write side-effect-free code for tree shaking
// utils.js - Good: pure functions
export const add = (a, b) => a + b;
export const multiply = (a, b) => a * b;
export const divide = (a, b) => a / b;

// Only used functions will be bundled
import { add } from './utils.js'; // Only 'add' bundled

// Bad: side effects prevent tree shaking
console.log('Module loaded'); // Side effect
export const add = (a, b) => a + b;

// Mark as side-effect-free in package.json
{
  "sideEffects": false,
  // OR specify files with side effects
  "sideEffects": ["*.css", "polyfills.js"]
}
```

## Module Patterns

```javascript
// Singleton pattern
// database.js
class Database {
  #connection = null;

  async connect() {
    if (!this.#connection) {
      this.#connection = await createConnection();
    }
    return this.#connection;
  }
}

export default new Database();

// Factory pattern
// loggerFactory.js
export function createLogger(level = 'info') {
  return {
    info: (msg) => level !== 'silent' && console.log(msg),
    error: (msg) => console.error(msg)
  };
}

// Facade pattern
// api.js
import { get, post, put, del } from './httpClient.js';
import { auth } from './auth.js';
import { cache } from './cache.js';

export const api = {
  async getUser(id) {
    const cached = cache.get(`user:${id}`);
    if (cached) return cached;

    const token = await auth.getToken();
    const user = await get(`/users/${id}`, { token });
    cache.set(`user:${id}`, user);
    return user;
  }
};
```

## Node.js ESM Specifics

```javascript
// package.json
{
  "type": "module" // All .js files are ESM
}

// Use .cjs for CommonJS files when type: "module"
// Use .mjs for ESM files when type: "commonjs" (default)

// Loading JSON in ESM
import data from './data.json' assert { type: 'json' };

// OR using fs
import { readFile } from 'fs/promises';
const data = JSON.parse(
  await readFile('./data.json', 'utf-8')
);

// Top-level await in Node.js ESM
const config = await fetch('/api/config').then(r => r.json());
export default config;
```

## Quick Reference

| Feature | ESM | CommonJS |
|---------|-----|----------|
| Syntax | `import`/`export` | `require()`/`module.exports` |
| Loading | Asynchronous | Synchronous |
| Tree shaking | Yes | No |
| Top-level await | Yes | No |
| Dynamic imports | `await import()` | `require()` |
| File extension | Required | Optional |
| `__dirname` | Use `import.meta.url` | Built-in |
| Browser support | Native | Needs bundler |
| Default mode | `"type": "module"` | No type field |

---

## Source: node-essentials.md

# Node.js Essentials

## File System (fs/promises)

```javascript
import { readFile, writeFile, appendFile, mkdir, rm, readdir, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';

// Read file
const content = await readFile('./file.txt', 'utf-8');

// Write file (overwrites)
await writeFile('./output.txt', 'Hello World');

// Append to file
await appendFile('./log.txt', 'New log entry\n');

// Read JSON file
const readJSON = async (path) => {
  const content = await readFile(path, 'utf-8');
  return JSON.parse(content);
};

// Write JSON file
const writeJSON = async (path, data) => {
  await writeFile(path, JSON.stringify(data, null, 2));
};

// Create directory (recursive)
await mkdir('./nested/path/dir', { recursive: true });

// Remove directory/file (recursive)
await rm('./temp', { recursive: true, force: true });

// List directory
const files = await readdir('./src');
const filesWithTypes = await readdir('./src', { withFileTypes: true });

for (const file of filesWithTypes) {
  if (file.isDirectory()) {
    console.log(`[DIR] ${file.name}`);
  } else {
    console.log(`[FILE] ${file.name}`);
  }
}

// Get file stats
const stats = await stat('./file.txt');
console.log('Size:', stats.size);
console.log('Modified:', stats.mtime);
console.log('Is file:', stats.isFile());

// Check existence (sync only)
if (existsSync('./path')) {
  // Path exists
}
```

## Path Module

```javascript
import { join, resolve, dirname, basename, extname, parse, format } from 'path';
import { fileURLToPath } from 'url';

// Get current file and directory in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Join paths (platform-independent)
const filePath = join(__dirname, 'data', 'config.json');

// Resolve to absolute path
const absolutePath = resolve('./relative/path');

// Get filename
const filename = basename('/path/to/file.txt'); // 'file.txt'
const filenameNoExt = basename('/path/to/file.txt', '.txt'); // 'file'

// Get extension
const ext = extname('file.txt'); // '.txt'

// Parse path
const parsed = parse('/home/user/file.txt');
// {
//   root: '/',
//   dir: '/home/user',
//   base: 'file.txt',
//   ext: '.txt',
//   name: 'file'
// }

// Format path
const formatted = format({
  dir: '/home/user',
  base: 'file.txt'
}); // '/home/user/file.txt'
```

## Streams

```javascript
import { createReadStream, createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { Transform } from 'stream';

// Read large file efficiently
const readStream = createReadStream('./large-file.txt', {
  encoding: 'utf-8',
  highWaterMark: 16 * 1024 // 16KB chunks
});

readStream.on('data', (chunk) => {
  console.log('Chunk:', chunk);
});

readStream.on('end', () => {
  console.log('Finished reading');
});

readStream.on('error', (error) => {
  console.error('Error:', error);
});

// Write stream
const writeStream = createWriteStream('./output.txt');
writeStream.write('Line 1\n');
writeStream.write('Line 2\n');
writeStream.end('Final line\n');

// Pipe streams
const input = createReadStream('./input.txt');
const output = createWriteStream('./output.txt');
input.pipe(output);

// Transform stream
const upperCaseTransform = new Transform({
  transform(chunk, encoding, callback) {
    const transformed = chunk.toString().toUpperCase();
    callback(null, transformed);
  }
});

await pipeline(
  createReadStream('./input.txt'),
  upperCaseTransform,
  createWriteStream('./output.txt')
);

// Async iteration over stream
const processStream = async (filePath) => {
  const stream = createReadStream(filePath, { encoding: 'utf-8' });

  for await (const chunk of stream) {
    processChunk(chunk);
  }
};
```

## EventEmitter

```javascript
import { EventEmitter } from 'events';

class DataProcessor extends EventEmitter {
  async process(data) {
    this.emit('start', { itemCount: data.length });

    for (let i = 0; i < data.length; i++) {
      await this.processItem(data[i]);
      this.emit('progress', { current: i + 1, total: data.length });
    }

    this.emit('complete', { processed: data.length });
  }

  async processItem(item) {
    // Processing logic
    if (item.error) {
      this.emit('error', new Error('Item processing failed'));
    }
  }
}

// Usage
const processor = new DataProcessor();

processor.on('start', ({ itemCount }) => {
  console.log(`Starting processing ${itemCount} items`);
});

processor.on('progress', ({ current, total }) => {
  console.log(`Progress: ${current}/${total}`);
});

processor.on('complete', ({ processed }) => {
  console.log(`Completed: ${processed} items`);
});

processor.on('error', (error) => {
  console.error('Processing error:', error);
});

// One-time listener
processor.once('complete', () => {
  console.log('First completion');
});

// Remove listener
const handler = () => console.log('Event fired');
processor.on('event', handler);
processor.off('event', handler);
```

## Child Processes

```javascript
import { spawn, exec, execFile } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Execute shell command
const { stdout, stderr } = await execAsync('ls -la');
console.log('Output:', stdout);

// Spawn process with streaming
const ls = spawn('ls', ['-la', '/usr']);

ls.stdout.on('data', (data) => {
  console.log(`stdout: ${data}`);
});

ls.stderr.on('data', (data) => {
  console.error(`stderr: ${data}`);
});

ls.on('close', (code) => {
  console.log(`Process exited with code ${code}`);
});

// Execute Node.js script
const child = spawn('node', ['script.js'], {
  cwd: './scripts',
  env: { ...process.env, CUSTOM_VAR: 'value' }
});
```

## Worker Threads

```javascript
import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';

if (isMainThread) {
  // Main thread
  const worker = new Worker(new URL(import.meta.url), {
    workerData: { items: [1, 2, 3, 4, 5] }
  });

  worker.on('message', (result) => {
    console.log('Result from worker:', result);
  });

  worker.on('error', (error) => {
    console.error('Worker error:', error);
  });

  worker.on('exit', (code) => {
    console.log(`Worker exited with code ${code}`);
  });

  worker.postMessage({ command: 'process' });
} else {
  // Worker thread
  const { items } = workerData;

  parentPort.on('message', (message) => {
    if (message.command === 'process') {
      const result = items.reduce((sum, n) => sum + n, 0);
      parentPort.postMessage(result);
    }
  });
}

// Worker pool pattern
class WorkerPool {
  #workers = [];
  #queue = [];

  constructor(workerPath, poolSize = 4) {
    for (let i = 0; i < poolSize; i++) {
      this.#workers.push({
        worker: new Worker(workerPath),
        busy: false
      });
    }
  }

  async execute(data) {
    return new Promise((resolve, reject) => {
      const task = { data, resolve, reject };
      this.#queue.push(task);
      this.#processQueue();
    });
  }

  #processQueue() {
    const availableWorker = this.#workers.find(w => !w.busy);
    if (!availableWorker || this.#queue.length === 0) return;

    const task = this.#queue.shift();
    availableWorker.busy = true;

    const handleMessage = (result) => {
      task.resolve(result);
      availableWorker.busy = false;
      availableWorker.worker.off('message', handleMessage);
      this.#processQueue();
    };

    availableWorker.worker.on('message', handleMessage);
    availableWorker.worker.postMessage(task.data);
  }
}
```

## Process & Environment

```javascript
// Environment variables
const port = process.env.PORT || 3000;
const isDev = process.env.NODE_ENV === 'development';

// Command-line arguments
const args = process.argv.slice(2);
console.log('Arguments:', args);

// Exit process
process.exit(0); // Success
process.exit(1); // Error

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down gracefully...');
  await cleanup();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('Received SIGTERM');
  await cleanup();
  process.exit(0);
});

// Unhandled errors
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled rejection:', reason);
  process.exit(1);
});

// Process info
console.log('PID:', process.pid);
console.log('Platform:', process.platform);
console.log('Node version:', process.version);
console.log('Memory usage:', process.memoryUsage());
console.log('Uptime:', process.uptime());
```

## HTTP/HTTPS Server

```javascript
import { createServer } from 'http';
import { readFile } from 'fs/promises';

const server = createServer(async (req, res) => {
  // Parse URL and method
  const { url, method } = req;

  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  // Route handling
  if (url === '/api/users' && method === 'GET') {
    const users = [{ id: 1, name: 'John' }];
    res.writeHead(200);
    res.end(JSON.stringify(users));
  } else if (url === '/api/users' && method === 'POST') {
    let body = '';

    req.on('data', chunk => {
      body += chunk.toString();
    });

    req.on('end', () => {
      const user = JSON.parse(body);
      res.writeHead(201);
      res.end(JSON.stringify({ id: 2, ...user }));
    });
  } else {
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
  }
});

server.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});

// Graceful shutdown
const shutdown = () => {
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
```

## Cluster for Multi-Core

```javascript
import cluster from 'cluster';
import { cpus } from 'os';
import { createServer } from 'http';

const numCPUs = cpus().length;

if (cluster.isPrimary) {
  console.log(`Primary ${process.pid} is running`);

  // Fork workers
  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
  }

  cluster.on('exit', (worker, code, signal) => {
    console.log(`Worker ${worker.process.pid} died`);
    cluster.fork(); // Restart worker
  });
} else {
  // Workers share TCP connection
  const server = createServer((req, res) => {
    res.writeHead(200);
    res.end(`Handled by worker ${process.pid}\n`);
  });

  server.listen(3000);
  console.log(`Worker ${process.pid} started`);
}
```

## Quick Reference

| Module | Use Case | Import |
|--------|----------|--------|
| `fs/promises` | Async file operations | `import { readFile } from 'fs/promises'` |
| `path` | Path manipulation | `import { join } from 'path'` |
| `stream` | Stream processing | `import { pipeline } from 'stream/promises'` |
| `events` | Event emitters | `import { EventEmitter } from 'events'` |
| `child_process` | Spawn processes | `import { spawn } from 'child_process'` |
| `worker_threads` | Multi-threading | `import { Worker } from 'worker_threads'` |
| `http` | HTTP server | `import { createServer } from 'http'` |
| `cluster` | Multi-core scaling | `import cluster from 'cluster'` |

---
