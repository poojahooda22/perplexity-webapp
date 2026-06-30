# Playwright E2E Testing
---

## Source: SKILL.md

---
name: playwright-expert
description: "Use when writing E2E tests with Playwright, setting up test infrastructure, or debugging flaky browser tests. Invoke to write test scripts, create page objects, configure test fixtures, set up reporters, add CI integration, implement API mocking, or perform visual regression testing. Trigger terms: Playwright, E2E test, end-to-end, browser testing, automation, UI testing, visual testing, Page Object Model, test flakiness."
license: MIT
metadata:
  author: https://github.com/Jeffallan
  version: "1.1.0"
  domain: quality
  triggers: Playwright, E2E test, end-to-end, browser testing, automation, UI testing, visual testing
  role: specialist
  scope: testing
  output-format: code
  related-skills: test-master, react-expert, devops-engineer
---

# Playwright Expert

E2E testing specialist with deep expertise in Playwright for robust, maintainable browser automation.

## Core Workflow

1. **Analyze requirements** - Identify user flows to test
2. **Setup** - Configure Playwright with proper settings
3. **Write tests** - Use POM pattern, proper selectors, auto-waiting
4. **Debug** - Run test → check trace → identify issue → fix → verify fix
5. **Integrate** - Add to CI/CD pipeline

## Reference Guide

Load detailed guidance based on context:

| Topic | Reference | Load When |
|-------|-----------|-----------|
| Selectors | `references/selectors-locators.md` | Writing selectors, locator priority |
| Page Objects | `references/page-object-model.md` | POM patterns, fixtures |
| API Mocking | `references/api-mocking.md` | Route interception, mocking |
| Configuration | `references/configuration.md` | playwright.config.ts setup |
| Debugging | `references/debugging-flaky.md` | Flaky tests, trace viewer |

## Constraints

### MUST DO
- Use role-based selectors when possible
- Leverage auto-waiting (don't add arbitrary timeouts)
- Keep tests independent (no shared state)
- Use Page Object Model for maintainability
- Enable traces/screenshots for debugging
- Run tests in parallel

### MUST NOT DO
- Use `waitForTimeout()` (use proper waits)
- Rely on CSS class selectors (brittle)
- Share state between tests
- Ignore flaky tests
- Use `first()`, `nth()` without good reason

## Code Examples

### Selector: Role-based (correct) vs CSS class (brittle)

```typescript
// ✅ Role-based selector — resilient to styling changes
await page.getByRole('button', { name: 'Submit' }).click();
await page.getByLabel('Email address').fill('user@example.com');

// ❌ CSS class selector — breaks on refactor
await page.locator('.btn-primary.submit-btn').click();
await page.locator('.email-input').fill('user@example.com');
```

### Page Object Model + Test File

```typescript
// pages/LoginPage.ts
import { type Page, type Locator } from '@playwright/test';

export class LoginPage {
  readonly page: Page;
  readonly emailInput: Locator;
  readonly passwordInput: Locator;
  readonly submitButton: Locator;
  readonly errorMessage: Locator;

  constructor(page: Page) {
    this.page = page;
    this.emailInput = page.getByLabel('Email address');
    this.passwordInput = page.getByLabel('Password');
    this.submitButton = page.getByRole('button', { name: 'Sign in' });
    this.errorMessage = page.getByRole('alert');
  }

  async goto() {
    await this.page.goto('/login');
  }

  async login(email: string, password: string) {
    await this.emailInput.fill(email);
    await this.passwordInput.fill(password);
    await this.submitButton.click();
  }
}
```

```typescript
// tests/login.spec.ts
import { test, expect } from '@playwright/test';
import { LoginPage } from '../pages/LoginPage';

test.describe('Login', () => {
  let loginPage: LoginPage;

  test.beforeEach(async ({ page }) => {
    loginPage = new LoginPage(page);
    await loginPage.goto();
  });

  test('successful login redirects to dashboard', async ({ page }) => {
    await loginPage.login('user@example.com', 'correct-password');
    await expect(page).toHaveURL('/dashboard');
  });

  test('invalid credentials shows error', async () => {
    await loginPage.login('user@example.com', 'wrong-password');
    await expect(loginPage.errorMessage).toBeVisible();
    await expect(loginPage.errorMessage).toContainText('Invalid credentials');
  });
});
```

### Debugging Workflow for Flaky Tests

```typescript
// 1. Run failing test with trace enabled
// playwright.config.ts
use: {
  trace: 'on-first-retry',
  screenshot: 'only-on-failure',
}

// 2. Re-run with retries to capture trace
// npx playwright test --retries=2

// 3. Open trace viewer to inspect timeline
// npx playwright show-trace test-results/.../trace.zip

// 4. Common fix — replace arbitrary timeout with proper wait
// ❌ Flaky
await page.waitForTimeout(2000);
await page.getByRole('button', { name: 'Save' }).click();

// ✅ Reliable — waits for element state
await page.getByRole('button', { name: 'Save' }).waitFor({ state: 'visible' });
await page.getByRole('button', { name: 'Save' }).click();

// 5. Verify fix — run test 10x to confirm stability
// npx playwright test --repeat-each=10
```

## Output Templates

When implementing Playwright tests, provide:
1. Page Object classes
2. Test files with proper assertions
3. Fixture setup if needed
4. Configuration recommendations

## Knowledge Reference

Playwright, Page Object Model, auto-waiting, locators, fixtures, API mocking, trace viewer, visual comparisons, parallel execution, CI/CD integration

---

## Source: api-mocking.md

# API Mocking

## Basic Route Mocking

```typescript
test('displays mocked user data', async ({ page }) => {
  await page.route('**/api/users', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        { id: 1, name: 'Alice' },
        { id: 2, name: 'Bob' },
      ]),
    })
  );

  await page.goto('/users');
  await expect(page.getByText('Alice')).toBeVisible();
  await expect(page.getByText('Bob')).toBeVisible();
});
```

## Mock Error Responses

```typescript
test('handles API error gracefully', async ({ page }) => {
  await page.route('**/api/users', route =>
    route.fulfill({
      status: 500,
      body: JSON.stringify({ error: 'Server error' }),
    })
  );

  await page.goto('/users');
  await expect(page.getByText('Failed to load users')).toBeVisible();
});
```

## Conditional Mocking

```typescript
test('mock specific requests', async ({ page }) => {
  await page.route('**/api/**', route => {
    const url = route.request().url();

    if (url.includes('/api/users')) {
      return route.fulfill({
        status: 200,
        json: [{ id: 1, name: 'Mocked User' }],
      });
    }

    // Let other requests through
    return route.continue();
  });
});
```

## Modify Responses

```typescript
test('modify API response', async ({ page }) => {
  await page.route('**/api/products', async route => {
    // Get real response
    const response = await route.fetch();
    const json = await response.json();

    // Modify it
    json.products = json.products.map(p => ({
      ...p,
      price: p.price * 0.9, // 10% discount
    }));

    // Return modified response
    await route.fulfill({ json });
  });
});
```

## Wait for Response

```typescript
test('waits for API response', async ({ page }) => {
  const responsePromise = page.waitForResponse('**/api/users');

  await page.getByRole('button', { name: 'Load Users' }).click();

  const response = await responsePromise;
  expect(response.status()).toBe(200);
});
```

## Mock Network Conditions

```typescript
test('slow network', async ({ page }) => {
  await page.route('**/api/**', async route => {
    await new Promise(resolve => setTimeout(resolve, 3000));
    await route.continue();
  });

  await page.goto('/dashboard');
  await expect(page.getByText('Loading...')).toBeVisible();
});
```

## HAR File Mocking

```typescript
// Record responses
await page.routeFromHAR('mocks/api.har', {
  url: '**/api/**',
  update: true, // Record new responses
});

// Playback recorded responses
await page.routeFromHAR('mocks/api.har', {
  url: '**/api/**',
  update: false,
});
```

## Quick Reference

| Method | Purpose |
|--------|---------|
| `route.fulfill()` | Return mock response |
| `route.continue()` | Pass to real server |
| `route.fetch()` | Get real response |
| `route.abort()` | Block request |
| `waitForResponse()` | Wait for API call |
| `routeFromHAR()` | Use recorded responses |

| Pattern | Use Case |
|---------|----------|
| Mock all | Isolated testing |
| Mock errors | Error handling |
| Modify response | Test edge cases |
| Network delay | Loading states |

---

## Source: configuration.md

# Configuration

## Full Configuration

```typescript
// playwright.config.ts
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [
    ['html'],
    ['json', { outputFile: 'results.json' }],
    ['junit', { outputFile: 'results.xml' }],
  ],

  use: {
    baseURL: 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    testIdAttribute: 'data-testid',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
    {
      name: 'mobile-chrome',
      use: { ...devices['Pixel 5'] },
    },
    {
      name: 'mobile-safari',
      use: { ...devices['iPhone 13'] },
    },
  ],

  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },
});
```

## Authentication Setup

```typescript
// global-setup.ts
import { chromium, FullConfig } from '@playwright/test';

async function globalSetup(config: FullConfig) {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  await page.goto('http://localhost:3000/login');
  await page.getByLabel('Email').fill('user@test.com');
  await page.getByLabel('Password').fill('password');
  await page.getByRole('button', { name: 'Log in' }).click();
  await page.waitForURL(/dashboard/);

  // Save auth state
  await page.context().storageState({ path: 'auth.json' });
  await browser.close();
}

export default globalSetup;

// playwright.config.ts
export default defineConfig({
  globalSetup: require.resolve('./global-setup'),
  use: {
    storageState: 'auth.json',
  },
});
```

## Project Dependencies

```typescript
projects: [
  {
    name: 'setup',
    testMatch: /global.setup\.ts/,
  },
  {
    name: 'chromium',
    use: { ...devices['Desktop Chrome'] },
    dependencies: ['setup'],
  },
],
```

## Environment Variables

```typescript
// playwright.config.ts
export default defineConfig({
  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:3000',
  },
});

// .env
BASE_URL=https://staging.example.com
```

## CI Configuration

```yaml
# .github/workflows/playwright.yml
name: Playwright Tests
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: npm ci
      - run: npx playwright install --with-deps
      - run: npx playwright test
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: playwright-report
          path: playwright-report/
```

## Quick Reference

| Option | Purpose |
|--------|---------|
| `testDir` | Test files location |
| `fullyParallel` | Run tests in parallel |
| `retries` | Retry failed tests |
| `trace` | Record trace on failure |
| `webServer` | Start dev server |
| `globalSetup` | Run before all tests |
| `storageState` | Reuse auth state |

---

## Source: debugging-flaky.md

# Debugging & Flaky Tests

## Debugging Tools

```typescript
// Pause execution and open inspector
await page.pause();

// Enable step-by-step mode
PWDEBUG=1 npx playwright test

// Slow motion
test.use({ launchOptions: { slowMo: 500 } });

// Headed mode
npx playwright test --headed
```

## Trace Viewer

```bash
# View trace from failed test
npx playwright show-trace trace.zip

# Generate trace always
test.use({ trace: 'on' });

# View in UI mode
npx playwright test --ui
```

## Common Flaky Test Causes

### 1. Race Conditions

```typescript
// ❌ Bad: Element may not exist yet
await page.click('.submit-btn');

// ✅ Good: Auto-waiting built in
await page.getByRole('button', { name: 'Submit' }).click();
```

### 2. Animation/Transitions

```typescript
// ❌ Bad: Click during animation
await page.click('.menu-item');

// ✅ Good: Wait for stable state
await page.getByRole('menuitem').click();
await expect(page.getByRole('menu')).toBeVisible();
```

### 3. Network Timing

```typescript
// ❌ Bad: Assumes data loaded
await page.goto('/dashboard');
expect(await page.textContent('.user-name')).toBe('John');

// ✅ Good: Wait for network
await page.goto('/dashboard');
await page.waitForResponse('**/api/user');
await expect(page.getByTestId('user-name')).toHaveText('John');
```

### 4. Test Isolation

```typescript
// ❌ Bad: Tests share state
test('test 1', async () => { /* creates user */ });
test('test 2', async () => { /* assumes user exists */ });

// ✅ Good: Each test is independent
test.beforeEach(async ({ page }) => {
  await page.request.post('/api/test/reset');
});
```

## Proper Waiting

```typescript
// Wait for element state
await expect(page.getByText('Success')).toBeVisible();
await expect(page.getByRole('button')).toBeEnabled();
await expect(page.getByRole('dialog')).toBeHidden();

// Wait for navigation
await page.waitForURL(/dashboard/);

// Wait for response
await page.waitForResponse(r => r.url().includes('/api/data'));

// Wait for load state
await page.waitForLoadState('networkidle');

// AVOID arbitrary waits
await page.waitForTimeout(3000); // ❌ BAD
```

## Retry Strategies

```typescript
// playwright.config.ts
export default defineConfig({
  retries: process.env.CI ? 2 : 0,

  // Retry only specific tests
  expect: {
    timeout: 10000, // Increase assertion timeout
  },
});

// Per-test retry
test('flaky test', async ({ page }) => {
  test.info().annotations.push({ type: 'issue', description: 'Known flaky' });
  // ...
});
```

## Debugging Output

```typescript
// Console output
test('debug test', async ({ page }) => {
  page.on('console', msg => console.log(msg.text()));
  page.on('pageerror', err => console.log(err.message));
});

// Screenshot on step
await page.screenshot({ path: 'debug.png' });
```

## Quick Reference

| Command | Purpose |
|---------|---------|
| `PWDEBUG=1` | Enable inspector |
| `--headed` | Show browser |
| `--ui` | UI mode |
| `page.pause()` | Pause execution |
| `show-trace` | View trace file |

| Fix | Flaky Cause |
|-----|-------------|
| Auto-wait locators | Race conditions |
| `waitForResponse` | Network timing |
| Test isolation | Shared state |
| Increase timeout | Slow operations |

---

## Source: page-object-model.md

# Page Object Model

## Basic Page Object

```typescript
// pages/LoginPage.ts
import { Page, Locator } from '@playwright/test';

export class LoginPage {
  readonly page: Page;
  readonly emailInput: Locator;
  readonly passwordInput: Locator;
  readonly submitButton: Locator;
  readonly errorMessage: Locator;

  constructor(page: Page) {
    this.page = page;
    this.emailInput = page.getByLabel('Email');
    this.passwordInput = page.getByLabel('Password');
    this.submitButton = page.getByRole('button', { name: 'Log in' });
    this.errorMessage = page.getByRole('alert');
  }

  async goto() {
    await this.page.goto('/login');
  }

  async login(email: string, password: string) {
    await this.emailInput.fill(email);
    await this.passwordInput.fill(password);
    await this.submitButton.click();
  }

  async getErrorMessage() {
    return this.errorMessage.textContent();
  }
}
```

## Using Page Objects in Tests

```typescript
// tests/login.spec.ts
import { test, expect } from '@playwright/test';
import { LoginPage } from '../pages/LoginPage';

test('successful login redirects to dashboard', async ({ page }) => {
  const loginPage = new LoginPage(page);

  await loginPage.goto();
  await loginPage.login('user@test.com', 'password123');

  await expect(page).toHaveURL(/dashboard/);
});

test('invalid credentials show error', async ({ page }) => {
  const loginPage = new LoginPage(page);

  await loginPage.goto();
  await loginPage.login('user@test.com', 'wrongpassword');

  await expect(loginPage.errorMessage).toBeVisible();
});
```

## Custom Fixtures

```typescript
// fixtures.ts
import { test as base } from '@playwright/test';
import { LoginPage } from './pages/LoginPage';
import { DashboardPage } from './pages/DashboardPage';

type Fixtures = {
  loginPage: LoginPage;
  dashboardPage: DashboardPage;
  authenticatedPage: Page;
};

export const test = base.extend<Fixtures>({
  loginPage: async ({ page }, use) => {
    await use(new LoginPage(page));
  },

  dashboardPage: async ({ page }, use) => {
    await use(new DashboardPage(page));
  },

  authenticatedPage: async ({ page }, use) => {
    const loginPage = new LoginPage(page);
    await loginPage.goto();
    await loginPage.login('user@test.com', 'password123');
    await page.waitForURL(/dashboard/);
    await use(page);
  },
});

export { expect } from '@playwright/test';
```

## Using Fixtures

```typescript
// tests/dashboard.spec.ts
import { test, expect } from '../fixtures';

test('shows user profile', async ({ authenticatedPage, dashboardPage }) => {
  await expect(dashboardPage.userProfile).toBeVisible();
});
```

## Component Page Objects

```typescript
// components/NavBar.ts
export class NavBar {
  constructor(private page: Page) {}

  readonly homeLink = () => this.page.getByRole('link', { name: 'Home' });
  readonly profileLink = () => this.page.getByRole('link', { name: 'Profile' });
  readonly logoutButton = () => this.page.getByRole('button', { name: 'Logout' });

  async logout() {
    await this.logoutButton().click();
  }
}

// pages/DashboardPage.ts
export class DashboardPage {
  readonly navBar: NavBar;

  constructor(private page: Page) {
    this.navBar = new NavBar(page);
  }
}
```

## Quick Reference

| Pattern | Purpose |
|---------|---------|
| Page Object | Encapsulate page interactions |
| Fixture | Share setup across tests |
| Component PO | Reusable UI components |
| Locator methods | Lazy evaluation |

| Best Practice | Reason |
|---------------|--------|
| Methods for actions | Readable tests |
| Locators as getters | Lazy evaluation |
| No assertions in PO | Flexibility |
| Fixtures for setup | DRY, maintainable |

---

## Source: selectors-locators.md

# Selectors & Locators

## Selector Priority (Best to Worst)

```typescript
// 1. Role-based (BEST - accessible)
await page.getByRole('button', { name: 'Submit' });
await page.getByRole('textbox', { name: 'Email' });
await page.getByRole('link', { name: 'Home' });
await page.getByRole('heading', { level: 1 });

// 2. Label/placeholder (good for forms)
await page.getByLabel('Email address');
await page.getByPlaceholder('Enter your email');

// 3. Test ID (good for non-semantic elements)
await page.getByTestId('user-avatar');
await page.getByTestId('submit-button');

// 4. Text content
await page.getByText('Welcome back');
await page.getByText(/welcome/i);  // Case insensitive

// 5. CSS/XPath (AVOID - brittle)
await page.locator('.submit-btn');  // Last resort
await page.locator('#email-input');
```

## Role-Based Selectors

```typescript
// Buttons
page.getByRole('button', { name: 'Submit' });
page.getByRole('button', { name: /save/i });

// Links
page.getByRole('link', { name: 'Documentation' });

// Inputs
page.getByRole('textbox', { name: 'Username' });
page.getByRole('checkbox', { name: 'Remember me' });
page.getByRole('combobox', { name: 'Country' });

// Navigation
page.getByRole('navigation');
page.getByRole('main');
page.getByRole('banner');

// Tables
page.getByRole('row', { name: 'John Doe' });
page.getByRole('cell', { name: 'Active' });
```

## Filtering Locators

```typescript
// Filter by text
page.getByRole('listitem').filter({ hasText: 'Product A' });

// Filter by child locator
page.getByRole('listitem').filter({
  has: page.getByRole('button', { name: 'Delete' })
});

// Filter by NOT having
page.getByRole('listitem').filter({
  hasNot: page.getByText('Sold out')
});

// Chain locators
page.getByTestId('product-card').getByRole('button', { name: 'Buy' });
```

## Handling Multiple Elements

```typescript
// Get nth element (0-indexed)
page.getByRole('listitem').nth(0);
page.getByRole('listitem').first();
page.getByRole('listitem').last();

// Count elements
const count = await page.getByRole('listitem').count();

// Iterate
for (const item of await page.getByRole('listitem').all()) {
  console.log(await item.textContent());
}
```

## Test IDs

```html
<!-- Add in HTML -->
<button data-testid="submit-button">Submit</button>
```

```typescript
// Configure custom attribute
// playwright.config.ts
use: {
  testIdAttribute: 'data-test-id'
}

// Use in tests
page.getByTestId('submit-button');
```

## Quick Reference

| Locator | Best For |
|---------|----------|
| `getByRole()` | Buttons, links, inputs |
| `getByLabel()` | Form fields |
| `getByPlaceholder()` | Inputs without labels |
| `getByTestId()` | Non-semantic elements |
| `getByText()` | Static text |
| `filter()` | Narrowing results |
| `nth()` / `first()` | Multiple matches |

---
