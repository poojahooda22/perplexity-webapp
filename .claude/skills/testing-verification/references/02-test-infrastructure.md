# Test Infrastructure — Frameworks & E2E
> Consolidated from test-master, test-browser, webapp-testing, playwright-expert. Zero-value-loss.
---

## Source: test-master


# Test Master

Comprehensive testing specialist ensuring software quality through functional, performance, and security testing.

## Core Workflow

1. **Define scope** — Identify what to test and which testing types apply
2. **Create strategy** — Plan the test approach across functional, performance, and security perspectives
3. **Write tests** — Implement tests with proper assertions (see example below)
4. **Execute** — Run tests and collect results
   - If tests fail: classify the failure (assertion error vs. environment/flakiness), fix root cause, re-run
   - If tests are flaky: isolate ordering dependencies, check async handling, add retry or stabilization logic
5. **Report** — Document findings with severity ratings and actionable fix recommendations
   - Verify coverage targets are met before closing; flag gaps explicitly

## Quick-Start Example

A minimal Jest unit test illustrating the key patterns this skill enforces:

```js
// ✅ Good: meaningful description, specific assertion, isolated dependency
describe('calculateDiscount', () => {
  it('applies 10% discount for premium users', () => {
    const result = calculateDiscount({ price: 100, userTier: 'premium' });
    expect(result).toBe(90); // specific outcome, not just truthy
  });

  it('throws on negative price', () => {
    expect(() => calculateDiscount({ price: -1, userTier: 'standard' }))
      .toThrow('Price must be non-negative');
  });
});
```

Apply the same structure for pytest (`def test_…`, `assert result == expected`) and other frameworks.

## Reference Guide

Load detailed guidance based on context:

<!-- TDD Iron Laws and Testing Anti-Patterns adapted from obra/superpowers by Jesse Vincent (@obra), MIT License -->

| Topic | Reference | Load When |
|-------|-----------|-----------|
| Unit Testing | `references/unit-testing.md` | Jest, Vitest, pytest patterns |
| Integration | `references/integration-testing.md` | API testing, Supertest |
| E2E | `references/e2e-testing.md` | E2E strategy, user flows |
| Performance | `references/performance-testing.md` | k6, load testing |
| Security | `references/security-testing.md` | Security test checklist |
| Reports | `references/test-reports.md` | Report templates, findings |
| QA Methodology | `references/qa-problem-solving-protocol.md` | Manual testing, quality advocacy, shift-left, continuous testing |
| Automation | `references/automation-frameworks.md` | Framework patterns, scaling, maintenance, team enablement |
| TDD Iron Laws | `references/tdd-iron-laws.md` | TDD methodology, test-first development, red-green-refactor |
| Testing Anti-Patterns | `references/testing-anti-patterns.md` | Test review, mock issues, test quality problems |

## Constraints

**MUST DO**
- Test happy paths AND error/edge cases (e.g., empty input, null, boundary values)
- Mock external dependencies — never call real APIs or databases in unit tests
- Use meaningful `it('…')` descriptions that read as plain-English specifications
- Assert specific outcomes (`expect(result).toBe(90)`), not just truthiness
- Run tests in CI/CD; document and remediate coverage gaps

**MUST NOT**
- Skip error-path testing (e.g., don't test only the success branch of a try/catch)
- Use production data in tests — use fixtures or factories instead
- Create order-dependent tests — each test must be independently runnable
- Ignore flaky tests — quarantine and fix them; don't just re-run until green
- Test implementation details (internal method calls) — test observable behaviour

## Output Templates

When creating test plans, provide:
1. Test scope and approach
2. Test cases with expected outcomes
3. Coverage analysis
4. Findings with severity (Critical/High/Medium/Low)
5. Specific fix recommendations
---

## Source: test-master/references / automation-frameworks.md

# Automation Frameworks

## Advanced Framework Patterns

### Screenplay Pattern
```typescript
// Better separation of concerns than POM
export class Actor {
  constructor(private page: Page) {}
  attemptsTo(...tasks: Task[]) {
    return Promise.all(tasks.map(t => t.performAs(this)));
  }
}

class Login implements Task {
  constructor(private email: string, private password: string) {}
  async performAs(actor: Actor) {
    await actor.page.getByLabel('Email').fill(this.email);
    await actor.page.getByLabel('Password').fill(this.password);
    await actor.page.getByRole('button', { name: 'Login' }).click();
  }
}

// Clear, maintainable test code
await new Actor(page).attemptsTo(new Login('user@test.com', 'pass'));
```

### Keyword-Driven Testing
```typescript
const keywords = {
  NAVIGATE: (page, url) => page.goto(url),
  CLICK: (page, selector) => page.click(selector),
  TYPE: (page, selector, text) => page.fill(selector, text),
  VERIFY: (page, selector) => expect(page.locator(selector)).toBeVisible(),
};

// Data drives execution - ideal for non-technical authors
const steps = [
  { keyword: 'NAVIGATE', args: ['/login'] },
  { keyword: 'TYPE', args: ['#email', 'user@test.com'] },
  { keyword: 'CLICK', args: ['#submit'] },
];

for (const step of steps) await keywords[step.keyword](page, ...step.args);
```

### Model-Based Testing
```typescript
// State machine defines valid transitions
const cartModel = {
  empty: { addItem: 'hasItems' },
  hasItems: { addItem: 'hasItems', removeItem: 'hasItems|empty', checkout: 'checkingOut' },
  checkingOut: { confirm: 'complete', cancel: 'hasItems' },
};

// Generate comprehensive test paths automatically
const testPaths = generatePathsFromModel(cartModel);
```

## Maintenance Strategies

### Self-Healing Locators
```typescript
// Multi-strategy finder with automatic fallback
async function findElement(page: Page, strategies: string[]): Promise<Locator> {
  for (const selector of strategies) {
    const el = page.locator(selector);
    if (await el.count() > 0) return el;
  }
  throw new Error(`Not found: ${strategies.join(', ')}`);
}

// Usage: tries best -> good -> fallback
const submit = await findElement(page, [
  '[data-testid="submit"]',     // Best: stable test ID
  'button:has-text("Submit")',  // Good: semantic
  'button.primary',             // Fallback: CSS
]);
```

### Error Recovery & Smart Retry
```typescript
// Auto-retry with recovery actions
async function clickWithRecovery(page: Page, selector: string, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      await page.click(selector, { timeout: 5000 });
      return;
    } catch (e) {
      if (i === retries - 1) throw e;
      await page.reload();
      await page.waitForLoadState('networkidle');
    }
  }
}

// Exponential backoff for flaky operations
async function retryWithBackoff<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i === retries - 1) throw e;
      await new Promise(r => setTimeout(r, 1000 * Math.pow(2, i)));
    }
  }
}
```

## Scaling Strategies

### Parallel & Distributed Execution
```typescript
// playwright.config.ts
export default defineConfig({
  workers: process.env.CI ? 8 : 4,
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  
  // Shard tests across multiple machines
  shard: process.env.SHARD ? {
    current: parseInt(process.env.SHARD_INDEX),
    total: parseInt(process.env.SHARD_TOTAL),
  } : undefined,
});
```

```yaml
# GitHub Actions: distribute across 5 workers
strategy:
  matrix:
    shard: [1, 2, 3, 4, 5]
steps:
  - run: npx playwright test --shard=${{ matrix.shard }}/5
```

### Resource Optimization
```typescript
// Reuse browser contexts for faster execution
let browser: Browser;
let context: BrowserContext;

test.beforeAll(async () => {
  browser = await chromium.launch();
  context = await browser.newContext();
});

test('test 1', async () => {
  const page = await context.newPage();
  // Test logic
  await page.close();
});

test.afterAll(async () => {
  await context.close();
  await browser.close();
});
```

## CI/CD Integration

### Complete Pipeline
```yaml
name: E2E Tests
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        shard: [1, 2, 3, 4]
    
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
      - run: npm ci
      - run: npx playwright install --with-deps
      
      - run: npx playwright test --shard=${{ matrix.shard }}/4
        env:
          CI: true
      
      - uses: actions/upload-artifact@v3
        if: always()
        with:
          name: report-${{ matrix.shard }}
          path: playwright-report/
```

### Test Data Factories
```typescript
export class UserFactory {
  static create(overrides?: Partial<User>): User {
    return {
      id: faker.string.uuid(),
      email: faker.internet.email(),
      name: faker.person.fullName(),
      role: 'user',
      ...overrides,
    };
  }

  static createMany(count: number) {
    return Array.from({ length: count }, () => this.create());
  }
}

// Seed test data
test.beforeEach(async ({ page }) => {
  await page.request.post('/api/test/seed', {
    data: { users: UserFactory.createMany(10) },
  });
});
```

## Team Enablement

### Training Program
```markdown
**Week 1-2**: Framework basics, page objects, first test
**Week 3-4**: Data-driven, API integration, CI/CD
**Week 5-6**: Performance, error handling, scaling
**Ongoing**: Code reviews, knowledge sharing
```

### Code Review Checklist
```markdown
- [ ] Independent tests (no order dependency)
- [ ] Semantic locators (getByRole, getByLabel)
- [ ] Proper waits (no arbitrary timeouts)
- [ ] Error cases tested
- [ ] Test data cleanup
- [ ] Meaningful test names
- [ ] Page objects updated
```

## Automation Strategy

### ROI Calculation
```typescript
const manual = { timePerRun: 30, runsPerSprint: 10 };
const automation = { development: 120, maintenance: 5 };

const timeSaved = (manual.timePerRun * manual.runsPerSprint) - automation.maintenance;
const breakEven = Math.ceil(automation.development / timeSaved);
const annualSavings = (timeSaved * 26 - automation.development) / 60; // hours

// Example: Break-even in 1 sprint, save 110 hours/year
```

### Selection Criteria
```markdown
**Automate**: Repetitive, stable UI, critical paths, data-driven, positive ROI
**Don't Automate**: Exploratory, changing UI, one-time, usability, negative ROI
```

## Reporting & Metrics

### Custom Reporter
```typescript
class MetricsReporter implements Reporter {
  onTestEnd(test: TestCase, result: TestResult) {
    this.sendMetrics({
      name: test.title,
      duration: result.duration,
      status: result.status,
      retries: result.retry,
    });
  }
}
```

## Quick Reference

| Pattern | Best For | Complexity |
|---------|----------|-----------|
| Page Object | Reusable components | Medium |
| Screenplay | Complex workflows | High |
| Keyword-Driven | Non-tech testers | Low |
| Model-Based | State machines | High |

| Scaling | Use Case |
|---------|----------|
| Parallel | Reduce time |
| Distributed | Large suites |
| Cloud | Cross-browser |
| Resource Reuse | Speed |

| Tool | Category |
|------|----------|
| Playwright, Cypress | Web E2E |
| Appium, Detox | Mobile |
| k6, Gatling | Performance |
---

## Source: test-master/references / e2e-testing.md

# E2E Testing

## E2E Test Strategy

```typescript
// Critical user paths to test
const criticalPaths = [
  'User registration and login',
  'Core product/service workflow',
  'Payment/checkout flow',
  'Settings and profile management',
];
```

## User Flow Testing

```typescript
import { test, expect } from '@playwright/test';

test.describe('User Registration Flow', () => {
  test('complete registration', async ({ page }) => {
    await page.goto('/register');

    await page.getByLabel('Email').fill('new@example.com');
    await page.getByLabel('Password').fill('SecurePass123!');
    await page.getByLabel('Confirm Password').fill('SecurePass123!');
    await page.getByRole('button', { name: 'Register' }).click();

    await expect(page).toHaveURL(/dashboard/);
    await expect(page.getByText('Welcome')).toBeVisible();
  });

  test('shows validation errors', async ({ page }) => {
    await page.goto('/register');

    await page.getByLabel('Email').fill('invalid');
    await page.getByRole('button', { name: 'Register' }).click();

    await expect(page.getByText('Invalid email')).toBeVisible();
  });
});
```

## Checkout Flow

```typescript
test.describe('Checkout Flow', () => {
  test('complete purchase', async ({ page }) => {
    // Add to cart
    await page.goto('/products/123');
    await page.getByRole('button', { name: 'Add to Cart' }).click();
    await expect(page.getByTestId('cart-count')).toHaveText('1');

    // Checkout
    await page.goto('/cart');
    await page.getByRole('button', { name: 'Checkout' }).click();

    // Payment
    await page.getByLabel('Card Number').fill('4242424242424242');
    await page.getByLabel('Expiry').fill('12/25');
    await page.getByLabel('CVC').fill('123');
    await page.getByRole('button', { name: 'Pay' }).click();

    // Confirmation
    await expect(page).toHaveURL(/order-confirmation/);
    await expect(page.getByText('Order Confirmed')).toBeVisible();
  });
});
```

## Test Data Management

```typescript
// fixtures/testData.ts
export const testUsers = {
  standard: {
    email: 'standard@test.com',
    password: 'TestPass123!',
  },
  admin: {
    email: 'admin@test.com',
    password: 'AdminPass123!',
  },
};

// Test setup
test.beforeEach(async ({ page }) => {
  // Seed test data
  await page.request.post('/api/test/seed');
});

test.afterEach(async ({ page }) => {
  // Clean up
  await page.request.post('/api/test/cleanup');
});
```

## Cross-Browser Testing

```typescript
// playwright.config.ts
export default defineConfig({
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    { name: 'mobile-chrome', use: { ...devices['Pixel 5'] } },
    { name: 'mobile-safari', use: { ...devices['iPhone 13'] } },
  ],
});
```

## Quick Reference

| Pattern | When to Use |
|---------|-------------|
| Happy path | Critical user journeys |
| Error handling | Form validation, API errors |
| Edge cases | Empty states, max limits |
| Cross-browser | Before major releases |
| Mobile | Responsive features |

| Priority | Test Coverage |
|----------|---------------|
| **P0** | Registration, login, core feature |
| **P1** | Payment, settings, common flows |
| **P2** | Edge cases, admin features |
| **P3** | Rare scenarios |
---

## Source: test-master/references / integration-testing.md

# Integration Testing

## API Testing (Supertest)

```typescript
import request from 'supertest';
import { app } from '../app';

describe('POST /api/users', () => {
  it('creates user with valid data', async () => {
    const response = await request(app)
      .post('/api/users')
      .send({ email: 'test@test.com', name: 'Test' })
      .expect(201);

    expect(response.body).toMatchObject({
      email: 'test@test.com',
      name: 'Test',
    });
    expect(response.body.id).toBeDefined();
  });

  it('returns 400 for invalid email', async () => {
    const response = await request(app)
      .post('/api/users')
      .send({ email: 'invalid', name: 'Test' })
      .expect(400);

    expect(response.body.error).toContain('email');
  });

  it('returns 401 without auth token', async () => {
    await request(app)
      .get('/api/users/me')
      .expect(401);
  });
});
```

## Authenticated Requests

```typescript
describe('Protected endpoints', () => {
  let authToken: string;

  beforeAll(async () => {
    const response = await request(app)
      .post('/api/auth/login')
      .send({ email: 'test@test.com', password: 'password' });
    authToken = response.body.token;
  });

  it('accesses protected route', async () => {
    await request(app)
      .get('/api/users/me')
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200);
  });
});
```

## Database Testing

```typescript
import { db } from '../database';

describe('UserRepository', () => {
  beforeEach(async () => {
    await db.query('DELETE FROM users');
  });

  afterAll(async () => {
    await db.end();
  });

  it('creates and retrieves user', async () => {
    const user = await userRepo.create({
      email: 'test@test.com',
      name: 'Test',
    });

    const found = await userRepo.findById(user.id);
    expect(found).toEqual(user);
  });
});
```

## pytest API Testing

```python
import pytest
from httpx import AsyncClient

@pytest.mark.asyncio
async def test_create_user(client: AsyncClient):
    response = await client.post("/api/users/", json={
        "email": "test@example.com",
        "name": "Test"
    })
    assert response.status_code == 201
    assert response.json()["email"] == "test@example.com"

@pytest.mark.asyncio
async def test_invalid_email(client: AsyncClient):
    response = await client.post("/api/users/", json={
        "email": "invalid",
        "name": "Test"
    })
    assert response.status_code == 422
```

## Quick Reference

| Method | Purpose |
|--------|---------|
| `.send(body)` | Send request body |
| `.set(header, value)` | Set header |
| `.expect(status)` | Assert status code |
| `.expect('Content-Type', /json/)` | Assert header |
| `response.body` | Parsed JSON body |
---

## Source: test-master/references / performance-testing.md

# Performance Testing

## k6 Load Test

```javascript
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '30s', target: 20 },   // Ramp up to 20 users
    { duration: '1m', target: 20 },    // Stay at 20 users
    { duration: '30s', target: 0 },    // Ramp down
  ],
  thresholds: {
    http_req_duration: ['p(95)<500'],  // 95% requests under 500ms
    http_req_failed: ['rate<0.01'],    // <1% errors
  },
};

export default function () {
  const res = http.get('http://localhost:3000/api/users');

  check(res, {
    'status is 200': (r) => r.status === 200,
    'response time < 200ms': (r) => r.timings.duration < 200,
  });

  sleep(1);
}
```

## Stress Test

```javascript
export const options = {
  stages: [
    { duration: '2m', target: 100 },   // Ramp to 100 users
    { duration: '5m', target: 100 },   // Stay at 100
    { duration: '2m', target: 200 },   // Push to 200
    { duration: '5m', target: 200 },   // Stay at 200
    { duration: '2m', target: 0 },     // Ramp down
  ],
};
```

## Spike Test

```javascript
export const options = {
  stages: [
    { duration: '10s', target: 10 },   // Normal load
    { duration: '1m', target: 10 },
    { duration: '10s', target: 200 },  // Spike!
    { duration: '3m', target: 200 },
    { duration: '10s', target: 10 },   // Scale down
    { duration: '3m', target: 10 },
    { duration: '10s', target: 0 },
  ],
};
```

## API Testing with Auth

```javascript
import http from 'k6/http';

export function setup() {
  const loginRes = http.post('http://localhost:3000/api/login', {
    email: 'test@test.com',
    password: 'password',
  });
  return { token: loginRes.json('token') };
}

export default function (data) {
  const params = {
    headers: { Authorization: `Bearer ${data.token}` },
  };

  http.get('http://localhost:3000/api/protected', params);
}
```

## Thresholds Reference

```javascript
thresholds: {
  // Response time
  http_req_duration: ['p(95)<500', 'p(99)<1000'],

  // Error rate
  http_req_failed: ['rate<0.01'],

  // Throughput
  http_reqs: ['rate>100'],

  // Custom metrics
  'http_req_duration{name:login}': ['p(95)<200'],
}
```

## Quick Reference

| Metric | Description |
|--------|-------------|
| `http_req_duration` | Response time |
| `http_req_failed` | Failed requests rate |
| `http_reqs` | Request rate |
| `p(95)` | 95th percentile |
| `rate` | Rate per second |

| Test Type | Purpose |
|-----------|---------|
| Load | Normal expected load |
| Stress | Find breaking point |
| Spike | Sudden traffic surge |
| Soak | Long duration stability |
---

## Source: test-master/references / qa-problem-solving-protocol.md

# QA Methodology

## Manual Testing Types

### Exploratory Testing
```markdown
**Charter**: Explore {feature} with focus on {aspect}
**Duration**: 60-90 min
**Mission**: Find defects in {specific functionality}

Test Ideas:
- Boundary conditions & edge cases
- Error handling & recovery
- User workflow variations
- Integration points

Findings:
1. [HIGH] {Issue + impact}
2. [MED] {Issue + impact}

Coverage: {Areas explored} | Risks: {Identified risks}
```

### Usability Testing
```markdown
**Task**: Can users complete {action} intuitively?
**Metrics**: Time to complete, errors made, satisfaction (1-5)
**Success**: 80% complete without help in <5 min

Observations:
- Navigation confusing at {step}
- Users expect {A} but get {B}
- Positive: {feature feedback}
```

### Accessibility Testing (WCAG 2.1 AA)
```typescript
test('accessibility compliance', async ({ page }) => {
  // Keyboard navigation
  await page.keyboard.press('Tab');
  expect(['A', 'BUTTON', 'INPUT']).toContain(
    await page.evaluate(() => document.activeElement.tagName)
  );
  
  // ARIA labels
  expect(await page.getByRole('button').first().getAttribute('aria-label')).toBeTruthy();
  
  // Color contrast (axe-core)
  const violations = await page.evaluate(async () => {
    const axe = await import('axe-core');
    return (await axe.run()).violations;
  });
  expect(violations).toHaveLength(0);
});
```

### Localization Testing
```markdown
**Test**: {Feature} in {language/locale}
- [ ] Text displays without truncation
- [ ] Date/time/currency formats correct
- [ ] Right-to-left layout (Arabic, Hebrew)
- [ ] Character encoding UTF-8
- [ ] Sort order respects locale
```

### Compatibility Matrix
```markdown
| Browser | Version | OS | Status |
|---------|---------|----|----- --|
| Chrome | Latest | Win/Mac | ✓ |
| Firefox | Latest | Win/Mac | ✓ |
| Safari | Latest | macOS/iOS | ✓ |
| Edge | Latest | Windows | ✓ |
```

## Test Design Techniques

### Pairwise Testing
```typescript
// Test all parameter pairs efficiently
const pairwiseTests = [
  { browser: 'chrome', os: 'windows', lang: 'en' },
  { browser: 'firefox', os: 'mac', lang: 'es' },
  { browser: 'safari', os: 'windows', lang: 'fr' },
  // Covers all pairs with minimal tests
];
```

### Risk-Based Testing
```markdown
| Risk | Probability | Impact | Priority | Test Effort |
|------|-------------|--------|----------|-------------|
| Critical | High | High | P0 | Exhaustive |
| High | Med-High | High | P1 | Comprehensive |
| Medium | Low-Med | Med | P2 | Standard |
| Low | Low | Low | P3 | Smoke only |
```

## Defect Management

### Root Cause Analysis (5 Whys)
```markdown
1. Why did defect occur? {User input not validated}
2. Why wasn't it validated? {Validation logic missing}
3. Why was it missing? {Requirement unclear}
4. Why was requirement unclear? {Acceptance criteria incomplete}
5. Why incomplete? {No QA review in planning}

**Root Cause**: QA not involved in requirements phase
**Prevention**: Add QA to all planning meetings
```

### Defect Report Template
```markdown
## [CRITICAL] {Defect Title}

**Steps to Reproduce**:
1. {Step 1}
2. {Step 2}

**Expected**: {Should happen}
**Actual**: {Actually happens}
**Impact**: {Business/user impact}
**Root Cause**: {Why it happened}
**Fix**: {Recommended solution}
```

## Quality Metrics

### Key Calculations
```typescript
// Defect Removal Efficiency (target: >95%)
const dre = (defectsInTesting / (defectsInTesting + defectsInProd)) * 100;

// Defect Leakage (target: <5%)
const leakage = (defectsInProd / totalDefects) * 100;

// Test Effectiveness (target: >90%)
const effectiveness = (defectsFoundByTests / totalDefects) * 100;

// Automation ROI
const roi = (timeSaved - maintenanceCost - developmentCost) / developmentCost;
```

### Quality Dashboard
```markdown
| Metric | Target | Actual | Trend | Status |
|--------|--------|--------|-------|--------|
| Coverage | >80% | 87% | ↑ | ✓ |
| Defect Leakage | <5% | 3% | ↓ | ✓ |
| Automation | >70% | 68% | ↑ | ⚠ |
| Critical Defects | 0 | 0 | → | ✓ |
| MTTR | <48h | 36h | ↓ | ✓ |
```

## Continuous Testing & Shift-Left

### Shift-Left Activities
```markdown
**Early Testing**:
- Review requirements for testability
- Create test cases during design
- TDD: unit tests with code
- Automated tests in CI pipeline
- Static analysis on commit
- Security scanning pre-merge

**Benefits**: 10x cheaper defect fixes, faster feedback
```

### Feedback Cycle Targets
```typescript
const feedbackCycle = {
  unitTests: '< 5 min',       // On save
  integration: '< 15 min',    // On commit
  e2e: '< 30 min',            // On PR
  regression: '< 2 hours',    // Nightly
};
```

## Quality Advocacy

### Quality Gates
```markdown
## Production Release Gate

**Must Pass (Blockers)**:
- [ ] Zero critical defects
- [ ] Coverage >80%
- [ ] All P0/P1 tests passing
- [ ] Performance SLA met
- [ ] Security scan clean
- [ ] Accessibility WCAG AA

**Decision**: GO | NO-GO | GO with exceptions
```

### Team Education Program
```markdown
**Week 1-2**: Test fundamentals
**Week 3-4**: Automation basics
**Week 5-6**: Advanced topics (perf, security, API)
**Ongoing**: Best practices, tool updates
```

## Test Planning

### Test Plan Template
```markdown
## Test Plan: {Feature}

**Scope**: {What to test}
**Types**: Unit, Integration, E2E, Perf, Security
**Resources**: {Team allocation}
**Dependencies**: {Prerequisites}
**Schedule**: {Timeline}
**Entry Criteria**: {Start conditions}
**Exit Criteria**: {Completion conditions}
**Risks**: {Identified risks + mitigation}
```

### Environment Strategy
```markdown
| Env | Purpose | Data | Refresh | Access |
|-----|---------|------|---------|--------|
| Dev | Development | Synthetic | On-demand | All |
| Test | QA testing | Test data | Daily | QA |
| Stage | Pre-prod | Prod-like | Weekly | Limited |
| Prod | Live | Real | N/A | Ops |
```

## Quick Reference

| Testing Type | When | Duration |
|--------------|------|----------|
| Exploratory | New features | 60-120 min |
| Usability | UI changes | 2-4 hours |
| Accessibility | Every release | 1-2 hours |
| Localization | Multi-region | 1 day/locale |

| Metric | Excellent | Good | Needs Work |
|--------|-----------|------|------------|
| Coverage | >90% | 70-90% | <70% |
| Leakage | <2% | 2-5% | >5% |
| Automation | >80% | 60-80% | <60% |
| MTTR | <24h | 24-48h | >48h |
---

## Source: test-master/references / security-testing.md

# Security Testing

## Authentication Tests

```typescript
describe('Authentication Security', () => {
  it('rejects invalid credentials', async () => {
    await request(app)
      .post('/api/login')
      .send({ email: 'user@test.com', password: 'wrong' })
      .expect(401);
  });

  it('rejects expired tokens', async () => {
    const expiredToken = createExpiredToken();
    await request(app)
      .get('/api/protected')
      .set('Authorization', `Bearer ${expiredToken}`)
      .expect(401);
  });

  it('rejects tampered tokens', async () => {
    const tamperedToken = validToken.slice(0, -5) + 'xxxxx';
    await request(app)
      .get('/api/protected')
      .set('Authorization', `Bearer ${tamperedToken}`)
      .expect(401);
  });

  it('enforces rate limiting on login', async () => {
    for (let i = 0; i < 6; i++) {
      await request(app)
        .post('/api/login')
        .send({ email: 'user@test.com', password: 'wrong' });
    }

    await request(app)
      .post('/api/login')
      .send({ email: 'user@test.com', password: 'correct' })
      .expect(429);
  });
});
```

## Authorization Tests

```typescript
describe('Authorization', () => {
  it('denies access to other users resources', async () => {
    await request(app)
      .get('/api/users/other-user-id/data')
      .set('Authorization', `Bearer ${userAToken}`)
      .expect(403);
  });

  it('denies admin routes to regular users', async () => {
    await request(app)
      .delete('/api/admin/users/123')
      .set('Authorization', `Bearer ${regularUserToken}`)
      .expect(403);
  });
});
```

## Input Validation Tests

```typescript
describe('Input Validation', () => {
  it('rejects SQL injection attempts', async () => {
    await request(app)
      .get('/api/users')
      .query({ search: "'; DROP TABLE users; --" })
      .expect(400);
  });

  it('rejects XSS in input fields', async () => {
    const response = await request(app)
      .post('/api/posts')
      .send({ title: '<script>alert("xss")</script>' })
      .expect(201);

    expect(response.body.title).not.toContain('<script>');
  });

  it('validates file upload types', async () => {
    await request(app)
      .post('/api/upload')
      .attach('file', 'malicious.exe')
      .expect(400);
  });
});
```

## Security Headers Test

```typescript
describe('Security Headers', () => {
  it('sets security headers', async () => {
    const response = await request(app).get('/');

    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['strict-transport-security']).toBeDefined();
  });
});
```

## Security Test Checklist

| Category | Tests |
|----------|-------|
| **Auth** | Invalid creds, token expiry, tampering |
| **Input** | SQL injection, XSS, command injection |
| **Access** | IDOR, privilege escalation |
| **Rate Limit** | Brute force, API abuse |
| **Headers** | CSP, HSTS, X-Frame-Options |
| **Data** | PII exposure, error messages |

## Quick Reference

| Vulnerability | Test Approach |
|---------------|---------------|
| SQL Injection | `'; DROP TABLE--` in inputs |
| XSS | `<script>alert(1)</script>` |
| IDOR | Access other user's resources |
| CSRF | Missing/invalid tokens |
| Auth Bypass | Missing auth, expired tokens |
---

## Source: test-master/references / tdd-iron-laws.md

# TDD Iron Laws

---

## The Fundamental Principle

> **NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST.**

This is non-negotiable. If you wrote production code before writing a failing test, delete it and start over. No exceptions.

---

## The Three Iron Laws

### Iron Law 1: The Fundamental Rule

> "You shall not write any production code unless it is to make a failing test pass."

Every line of production code must have a corresponding test that:
1. Was written first
2. Was observed to fail
3. Now passes because of that code

### Iron Law 2: Proof Through Observation

> "If you didn't watch the test fail, you don't know if it tests the right thing."

Mandatory verification steps:
- Write the test
- Run it and **observe the failure**
- Verify the failure message is meaningful
- Only then implement the fix

A test you've never seen fail proves nothing.

### Iron Law 3: The Final Rule

> "Production code exists → A test exists that failed first. Otherwise → It's not TDD."

There is no middle ground. Code written without a prior failing test is not test-driven development, regardless of how many tests exist afterward.

---

## The RED-GREEN-REFACTOR Cycle

### RED: Write One Minimal Failing Test

```typescript
// Start with the smallest possible failing test
it('should return 0 for empty array', () => {
  expect(sum([])).toBe(0);
});
// Run: ✗ FAIL - sum is not defined
```

**Requirements:**
- One test at a time
- Minimal scope
- Clear failure message
- Observe the red

### GREEN: Implement Simplest Passing Code

```typescript
// Write only enough code to pass this specific test
function sum(numbers: number[]): number {
  return 0;
}
// Run: ✓ PASS
```

**Requirements:**
- Simplest possible implementation
- No extra features
- No optimization
- Just make it pass

### REFACTOR: Improve While Keeping Tests Green

```typescript
// Now improve the code while tests stay green
function sum(numbers: number[]): number {
  return numbers.reduce((acc, n) => acc + n, 0);
}
// Run: ✓ PASS (still)
```

**Requirements:**
- Tests must stay green
- Remove duplication
- Improve clarity
- No new functionality

---

## Common Rationalizations to Reject

These thoughts indicate you're about to violate TDD:

| Rationalization | Why It's Wrong |
|-----------------|----------------|
| "I can manually test this quickly" | Manual testing doesn't prevent regression |
| "I'll write tests after to save time" | You'll skip edge cases and test implementation |
| "This is too simple to need a test" | Simple code changes; tests document expectations |
| "I've already written the code, I can't delete it now" | Sunk cost fallacy; delete it |
| "I know this works, I've done it before" | Your memory isn't documentation |
| "We're in a hurry" | Technical debt costs more than TDD |

---

## Practical Application

### Starting a New Feature

```typescript
// 1. RED: Write failing test for simplest behavior
describe('UserValidator', () => {
  it('should reject empty email', () => {
    expect(validateEmail('')).toBe(false);
  });
});

// 2. GREEN: Implement minimal passing code
function validateEmail(email: string): boolean {
  return email.length > 0;
}

// 3. RED: Add next failing test
it('should reject email without @', () => {
  expect(validateEmail('invalid')).toBe(false);
});

// 4. GREEN: Extend to pass both tests
function validateEmail(email: string): boolean {
  return email.length > 0 && email.includes('@');
}

// Continue cycle...
```

### Fixing a Bug

```typescript
// 1. RED: Write test that exposes the bug
it('should handle negative numbers in sum', () => {
  expect(sum([-1, -2, -3])).toBe(-6);
});
// Run: ✗ FAIL - got 0 instead of -6

// 2. GREEN: Fix the bug
function sum(numbers: number[]): number {
  return numbers.reduce((acc, n) => acc + n, 0);
}
// Run: ✓ PASS

// Bug is now fixed AND protected against regression
```

---

## Verification Checklist

Before claiming any code is complete:

- [ ] Every production function has corresponding tests
- [ ] Each test was written before its implementation
- [ ] Each test was observed to fail first
- [ ] Tests verify behavior, not implementation
- [ ] Refactoring kept all tests green
- [ ] No production code exists without a test

---

*Content adapted from [obra/superpowers](https://github.com/obra/superpowers) by Jesse Vincent (@obra), MIT License.*
---

## Source: test-master/references / test-reports.md

# Test Reports

## Test Report Template

```markdown
# Test Report: {Feature Name}

**Date**: YYYY-MM-DD
**Tester**: {Name}
**Version**: {App Version}

## Summary

| Metric | Value |
|--------|-------|
| Total Tests | X |
| Passed | X |
| Failed | X |
| Skipped | X |
| Coverage | X% |

## Test Scope

- [x] Unit tests
- [x] Integration tests
- [x] E2E tests
- [ ] Performance tests
- [ ] Security tests

## Findings

### [CRITICAL] {Issue Title}
- **Location**: src/api/users.ts:45
- **Steps to Reproduce**:
  1. Send POST to /api/users without auth
  2. Request succeeds with 201
- **Expected**: 401 Unauthorized
- **Actual**: 201 Created
- **Impact**: Unauthorized user creation
- **Fix**: Add auth middleware

### [HIGH] {Issue Title}
- **Location**: src/services/orders.ts:123
- **Description**: N+1 query in order list
- **Impact**: 3s response time with 100 orders
- **Fix**: Add eager loading for order items

### [MEDIUM] {Issue Title}
- **Details**: ...

### [LOW] {Issue Title}
- **Details**: ...

## Coverage Analysis

| Module | Lines | Branches | Functions |
|--------|-------|----------|-----------|
| api/ | 85% | 78% | 90% |
| services/ | 92% | 85% | 95% |
| utils/ | 100% | 100% | 100% |

### Coverage Gaps
- `src/api/admin.ts` - 0% (no tests)
- `src/services/payment.ts:45-60` - Error handling untested

## Recommendations

1. **Immediate**: Add auth middleware to admin routes
2. **High Priority**: Optimize order queries
3. **Medium Priority**: Add tests for payment error handling
4. **Low Priority**: Increase branch coverage in api/

## Performance Results

| Endpoint | p50 | p95 | p99 |
|----------|-----|-----|-----|
| GET /users | 45ms | 120ms | 250ms |
| POST /orders | 150ms | 400ms | 800ms |

## Sign-off

- [ ] All critical issues addressed
- [ ] Coverage meets threshold (80%)
- [ ] Performance meets SLA
```

## Severity Definitions

| Severity | Criteria |
|----------|----------|
| **CRITICAL** | Security vulnerability, data loss, system crash |
| **HIGH** | Major functionality broken, severe performance |
| **MEDIUM** | Feature partially working, workaround exists |
| **LOW** | Minor issue, cosmetic, edge case |

## Quick Reference

| Section | Content |
|---------|---------|
| Summary | High-level metrics |
| Findings | Issues by severity |
| Coverage | Code coverage analysis |
| Recommendations | Prioritized actions |
| Sign-off | Approval criteria |
---

## Source: test-master/references / testing-anti-patterns.md

# Testing Anti-Patterns

---

## Core Principle

> **"Test what the code does, not what the mocks do."**

When tests verify mock behavior instead of actual functionality, they provide false confidence while catching zero real bugs.

---

## The Five Anti-Patterns

### Anti-Pattern 1: Testing Mock Behavior

**The Problem:** Verifying that mocks exist and were called, rather than testing actual component output.

```typescript
// ❌ BAD: Testing the mock, not the behavior
it('should call the API', () => {
  const mockApi = jest.fn().mockResolvedValue({ data: 'test' });
  const service = new UserService(mockApi);

  service.getUser(1);

  expect(mockApi).toHaveBeenCalledWith(1); // Testing mock, not result
});
```

```typescript
// ✅ GOOD: Testing actual behavior
it('should return user data from API', async () => {
  const mockApi = jest.fn().mockResolvedValue({ id: 1, name: 'Alice' });
  const service = new UserService(mockApi);

  const user = await service.getUser(1);

  expect(user.name).toBe('Alice'); // Testing actual output
});
```

**Solution:** Test the genuine component output. If you can only verify mock calls, reconsider whether the test adds value.

---

### Anti-Pattern 2: Test-Only Methods in Production

**The Problem:** Adding methods to production classes solely for test setup or cleanup.

```typescript
// ❌ BAD: Production code polluted with test concerns
class UserCache {
  private cache: Map<number, User> = new Map();

  getUser(id: number): User | undefined {
    return this.cache.get(id);
  }

  // This method exists ONLY for tests
  _resetForTesting(): void {
    this.cache.clear();
  }
}
```

```typescript
// ✅ GOOD: Test utilities separate from production
// production/UserCache.ts
class UserCache {
  private cache: Map<number, User> = new Map();

  getUser(id: number): User | undefined {
    return this.cache.get(id);
  }
}

// test/helpers.ts
function createFreshCache(): UserCache {
  return new UserCache(); // Fresh instance per test
}
```

**Solution:** Relocate cleanup logic to test utility functions. Use fresh instances per test instead of reset methods.

---

### Anti-Pattern 3: Mocking Without Understanding

**The Problem:** Over-mocking without grasping side effects, leading to tests that pass but hide real issues.

```typescript
// ❌ BAD: Mocking everything without understanding
it('should process order', async () => {
  jest.mock('./inventory');
  jest.mock('./payment');
  jest.mock('./shipping');
  jest.mock('./notifications');

  const result = await processOrder(order);

  expect(result.success).toBe(true); // What did we actually test?
});
```

```typescript
// ✅ GOOD: Strategic mocking with real components where possible
it('should process order with real inventory check', async () => {
  // Real inventory service against test database
  const inventory = new InventoryService(testDb);

  // Mock only external services
  const payment = mockPaymentGateway();

  const processor = new OrderProcessor(inventory, payment);
  const result = await processor.process(order);

  expect(result.success).toBe(true);
  expect(await inventory.getStock(order.itemId)).toBe(originalStock - 1);
});
```

**Solution:** Run tests with real implementations first to understand behavior. Then mock at the appropriate level - external services, not internal logic.

---

### Anti-Pattern 4: Incomplete Mocks

**The Problem:** Partial mock responses missing downstream fields that production code expects.

```typescript
// ❌ BAD: Incomplete mock response
const mockUserApi = jest.fn().mockResolvedValue({
  id: 1,
  name: 'Test User'
  // Missing: email, createdAt, permissions, settings...
});

// Test passes, but production crashes when accessing user.email
```

```typescript
// ✅ GOOD: Complete mock matching real API response
const mockUserApi = jest.fn().mockResolvedValue({
  id: 1,
  name: 'Test User',
  email: 'test@example.com',
  createdAt: '2024-01-01T00:00:00Z',
  permissions: ['read', 'write'],
  settings: {
    theme: 'light',
    notifications: true
  }
});

// Or use a factory
const mockUserApi = jest.fn().mockResolvedValue(
  createMockUser({ name: 'Test User' }) // Factory fills defaults
);
```

**Solution:** Mirror complete real API response structure. Use factories to generate complete mock objects with sensible defaults.

---

### Anti-Pattern 5: Integration Tests as Afterthought

**The Problem:** Treating testing as optional follow-up work rather than integral to development.

```typescript
// ❌ BAD: "We'll add tests later"
// Day 1: Write 500 lines of code
// Day 2: Write 500 more lines
// Day 3: "We need to ship, tests can wait"
// Day 30: Catastrophic bug in production
// Day 31: "Why didn't we have tests?"
```

```typescript
// ✅ GOOD: Tests are part of implementation
// Write failing test
it('should reject duplicate usernames', async () => {
  await createUser({ username: 'alice' });

  await expect(createUser({ username: 'alice' }))
    .rejects.toThrow('Username already exists');
});

// Make it pass
async function createUser(data: UserInput): Promise<User> {
  const existing = await db.users.findByUsername(data.username);
  if (existing) {
    throw new Error('Username already exists');
  }
  return db.users.create(data);
}

// Feature AND test ship together
```

**Solution:** Follow TDD - testing is implementation, not documentation. No feature is "done" without tests.

---

## Detection Checklist

Review your tests for these warning signs:

| Warning Sign | Anti-Pattern |
|-------------|--------------|
| `expect(mock).toHaveBeenCalled()` without testing output | Testing mock behavior |
| Methods starting with `_` or `ForTesting` in production | Test-only methods |
| Every dependency is mocked | Mocking without understanding |
| Mocks return `{ success: true }` only | Incomplete mocks |
| Test files added weeks after feature ships | Tests as afterthought |

---

## Quick Reference

| Anti-Pattern | Symptom | Fix |
|-------------|---------|-----|
| Testing mocks | Only mock assertions, no behavior tests | Assert on actual output |
| Test-only methods | `_reset()`, `_setForTest()` in prod | Use fresh instances |
| Over-mocking | 10+ mocks per test | Test with real deps first |
| Incomplete mocks | Minimal stub responses | Use factories, match reality |
| Tests as afterthought | Features ship untested | TDD from the start |

---

*Content adapted from [obra/superpowers](https://github.com/obra/superpowers) by Jesse Vincent (@obra), MIT License.*
---

## Source: test-master/references / unit-testing.md

# Unit Testing

## Jest/Vitest Pattern

```typescript
describe('UserService', () => {
  let service: UserService;
  let mockRepo: jest.Mocked<UserRepository>;

  beforeEach(() => {
    mockRepo = { findById: jest.fn(), save: jest.fn() } as any;
    service = new UserService(mockRepo);
  });

  afterEach(() => jest.clearAllMocks());

  describe('getUser', () => {
    it('returns user when found', async () => {
      const user = { id: '1', name: 'Test' };
      mockRepo.findById.mockResolvedValue(user);

      const result = await service.getUser('1');

      expect(result).toEqual(user);
      expect(mockRepo.findById).toHaveBeenCalledWith('1');
    });

    it('throws NotFoundError when user not found', async () => {
      mockRepo.findById.mockResolvedValue(null);

      await expect(service.getUser('1')).rejects.toThrow(NotFoundError);
    });
  });
});
```

## pytest Pattern

```python
import pytest
from unittest.mock import Mock, AsyncMock

class TestUserService:
    @pytest.fixture
    def mock_repo(self):
        return Mock()

    @pytest.fixture
    def service(self, mock_repo):
        return UserService(mock_repo)

    async def test_get_user_returns_user(self, service, mock_repo):
        mock_repo.find_by_id = AsyncMock(return_value={"id": "1", "name": "Test"})

        result = await service.get_user("1")

        assert result == {"id": "1", "name": "Test"}
        mock_repo.find_by_id.assert_called_once_with("1")

    async def test_get_user_raises_not_found(self, service, mock_repo):
        mock_repo.find_by_id = AsyncMock(return_value=None)

        with pytest.raises(NotFoundError):
            await service.get_user("1")
```

## Mocking Patterns

```typescript
// Mock functions
const mockFn = jest.fn();
mockFn.mockReturnValue('value');
mockFn.mockResolvedValue('async value');
mockFn.mockRejectedValue(new Error('error'));

// Mock modules
jest.mock('./database', () => ({
  query: jest.fn(),
}));

// Spy on existing methods
jest.spyOn(console, 'log').mockImplementation(() => {});
```

## Test Organization

```typescript
describe('Feature', () => {
  describe('happy path', () => {
    it('does expected behavior', () => {});
  });

  describe('edge cases', () => {
    it('handles empty input', () => {});
    it('handles max values', () => {});
  });

  describe('error cases', () => {
    it('throws on invalid input', () => {});
  });
});
```

## Quick Reference

| Pattern | Use Case |
|---------|----------|
| `describe()` | Group related tests |
| `it()` / `test()` | Single test case |
| `beforeEach()` | Setup before each test |
| `jest.fn()` | Create mock function |
| `mockResolvedValue()` | Mock async return |
| `expect().toThrow()` | Assert exception |
---

## Source: test-browser


# Browser Test Command

<command_purpose>Run end-to-end browser tests on pages affected by a PR or branch changes using agent-browser CLI.</command_purpose>

## CRITICAL: Use agent-browser CLI Only

**DO NOT use Chrome MCP tools (mcp__claude-in-chrome__*).**

This command uses the `agent-browser` CLI exclusively. The agent-browser CLI is a Bash-based tool from Vercel that runs headless Chromium. It is NOT the same as Chrome browser automation via MCP.

If you find yourself calling `mcp__claude-in-chrome__*` tools, STOP. Use `agent-browser` Bash commands instead.

## Introduction

<role>QA Engineer specializing in browser-based end-to-end testing</role>

This command tests affected pages in a real browser, catching issues that unit tests miss:
- JavaScript integration bugs
- CSS/layout regressions
- User workflow breakages
- Console errors

## Prerequisites

<requirements>
- Local development server running (e.g., `bin/dev`, `rails server`, `npm run dev`)
- agent-browser CLI installed (see Setup below)
- Git repository with changes to test
</requirements>

## Setup

**Check installation:**
```bash
command -v agent-browser >/dev/null 2>&1 && echo "Installed" || echo "NOT INSTALLED"
```

**Install if needed:**
```bash
npm install -g agent-browser
agent-browser install  # Downloads Chromium (~160MB)
```

See the `agent-browser` skill for detailed usage.

## Main Tasks

### 0. Verify agent-browser Installation

Before starting ANY browser testing, verify agent-browser is installed:

```bash
command -v agent-browser >/dev/null 2>&1 && echo "Ready" || (echo "Installing..." && npm install -g agent-browser && agent-browser install)
```

If installation fails, inform the user and stop.

### 1. Ask Browser Mode

<ask_browser_mode>

Before starting tests, ask user if they want to watch the browser:

Use AskUserQuestion with:
- Question: "Do you want to watch the browser tests run?"
- Options:
  1. **Headed (watch)** - Opens visible browser window so you can see tests run
  2. **Headless (faster)** - Runs in background, faster but invisible

Store the choice and use `--headed` flag when user selects "Headed".

</ask_browser_mode>

### 2. Determine Test Scope

<test_target> $ARGUMENTS </test_target>

<determine_scope>

**If PR number provided:**
```bash
gh pr view [number] --json files -q '.files[].path'
```

**If 'current' or empty:**
```bash
git diff --name-only main...HEAD
```

**If branch name provided:**
```bash
git diff --name-only main...[branch]
```

</determine_scope>

### 3. Map Files to Routes

<file_to_route_mapping>

Map changed files to testable routes:

| File Pattern | Route(s) |
|-------------|----------|
| `app/views/users/*` | `/users`, `/users/:id`, `/users/new` |
| `app/controllers/settings_controller.rb` | `/settings` |
| `app/javascript/controllers/*_controller.js` | Pages using that Stimulus controller |
| `app/components/*_component.rb` | Pages rendering that component |
| `app/views/layouts/*` | All pages (test homepage at minimum) |
| `app/assets/stylesheets/*` | Visual regression on key pages |
| `app/helpers/*_helper.rb` | Pages using that helper |
| `src/app/*` (web framework routes) | Corresponding routes |
| `src/components/*` | Pages using those components |

Build a list of URLs to test based on the mapping.

</file_to_route_mapping>

### 4. Detect Dev Server Port

<detect_port>

Determine the dev server port using this priority order:

**Priority 1: Explicit argument**
If the user passed a port number (e.g., `/test-browser 5000` or `/test-browser --port 5000`), use that port directly.

**Priority 2: CLAUDE.md / project instructions**
```bash
# Check CLAUDE.md for port references
grep -Eio '(port\s*[:=]\s*|localhost:)([0-9]{4,5})' CLAUDE.md 2>/dev/null | grep -Eo '[0-9]{4,5}' | head -1
```

**Priority 3: package.json scripts**
```bash
# Check dev/start scripts for --port flags
grep -Eo '\-\-port[= ]+[0-9]{4,5}' package.json 2>/dev/null | grep -Eo '[0-9]{4,5}' | head -1
```

**Priority 4: Environment files**
```bash
# Check .env, .env.local, .env.development for PORT=
grep -h '^PORT=' .env .env.local .env.development 2>/dev/null | tail -1 | cut -d= -f2
```

**Priority 5: Default fallback**
If none of the above yields a port, default to `3000`.

Store the result in a `PORT` variable for use in all subsequent steps.

```bash
# Combined detection (run this)
PORT="${EXPLICIT_PORT:-}"
if [ -z "$PORT" ]; then
  PORT=$(grep -Eio '(port\s*[:=]\s*|localhost:)([0-9]{4,5})' CLAUDE.md 2>/dev/null | grep -Eo '[0-9]{4,5}' | head -1)
fi
if [ -z "$PORT" ]; then
  PORT=$(grep -Eo '\-\-port[= ]+[0-9]{4,5}' package.json 2>/dev/null | grep -Eo '[0-9]{4,5}' | head -1)
fi
if [ -z "$PORT" ]; then
  PORT=$(grep -h '^PORT=' .env .env.local .env.development 2>/dev/null | tail -1 | cut -d= -f2)
fi
PORT="${PORT:-3000}"
echo "Using dev server port: $PORT"
```

</detect_port>

### 5. Verify Server is Running

<check_server>

Before testing, verify the local server is accessible using the detected port:

```bash
agent-browser open http://localhost:${PORT}
agent-browser snapshot -i
```

If server is not running, inform user:
```markdown
**Server not running on port ${PORT}**

Please start your development server:
- Rails: `bin/dev` or `rails server`
- Node/Next.js: `npm run dev`
- Custom port: `/test-browser --port <your-port>`

Then run `/test-browser` again.
```

</check_server>

### 6. Test Each Affected Page

<test_pages>

For each affected route, use agent-browser CLI commands (NOT Chrome MCP):

**Step 1: Navigate and capture snapshot**
```bash
agent-browser open "http://localhost:${PORT}/[route]"
agent-browser snapshot -i
```

**Step 2: For headed mode (visual debugging)**
```bash
agent-browser --headed open "http://localhost:${PORT}/[route]"
agent-browser --headed snapshot -i
```

**Step 3: Verify key elements**
- Use `agent-browser snapshot -i` to get interactive elements with refs
- Page title/heading present
- Primary content rendered
- No error messages visible
- Forms have expected fields

**Step 4: Test critical interactions**
```bash
agent-browser click @e1  # Use ref from snapshot
agent-browser snapshot -i
```

**Step 5: Take screenshots**
```bash
agent-browser screenshot page-name.png
agent-browser screenshot --full page-name-full.png  # Full page
```

</test_pages>

### 7. Human Verification (When Required)

<human_verification>

Pause for human input when testing touches:

| Flow Type | What to Ask |
|-----------|-------------|
| OAuth | "Please sign in with [provider] and confirm it works" |
| Email | "Check your inbox for the test email and confirm receipt" |
| Payments | "Complete a test purchase in sandbox mode" |
| SMS | "Verify you received the SMS code" |
| External APIs | "Confirm the [service] integration is working" |

Use AskUserQuestion:
```markdown
**Human Verification Needed**

This test touches the [flow type]. Please:
1. [Action to take]
2. [What to verify]

Did it work correctly?
1. Yes - continue testing
2. No - describe the issue
```

</human_verification>

### 8. Handle Failures

<failure_handling>

When a test fails:

1. **Document the failure:**
   - Screenshot the error state: `agent-browser screenshot error.png`
   - Note the exact reproduction steps

2. **Ask user how to proceed:**
   ```markdown
   **Test Failed: [route]**

   Issue: [description]
   Console errors: [if any]

   How to proceed?
   1. Fix now - I'll help debug and fix
   2. Create todo - Add to todos/ for later
   3. Skip - Continue testing other pages
   ```

3. **If "Fix now":**
   - Investigate the issue
   - Propose a fix
   - Apply fix
   - Re-run the failing test

4. **If "Create todo":**
   - Create `{id}-pending-p1-browser-test-{description}.md`
   - Continue testing

5. **If "Skip":**
   - Log as skipped
   - Continue testing

</failure_handling>

### 9. Test Summary

<test_summary>

After all tests complete, present summary:

```markdown
## Browser Test Results

**Test Scope:** PR #[number] / [branch name]
**Server:** http://localhost:${PORT}

### Pages Tested: [count]

| Route | Status | Notes |
|-------|--------|-------|
| `/users` | Pass | |
| `/settings` | Pass | |
| `/dashboard` | Fail | Console error: [msg] |
| `/checkout` | Skip | Requires payment credentials |

### Console Errors: [count]
- [List any errors found]

### Human Verifications: [count]
- OAuth flow: Confirmed
- Email delivery: Confirmed

### Failures: [count]
- `/dashboard` - [issue description]

### Created Todos: [count]
- `005-pending-p1-browser-test-dashboard-error.md`

### Result: [PASS / FAIL / PARTIAL]
```

</test_summary>

## Quick Usage Examples

```bash
# Test current branch changes (auto-detects port)
/test-browser

# Test specific PR
/test-browser 847

# Test specific branch
/test-browser feature/new-dashboard

# Test on a specific port
/test-browser --port 5000
```

## agent-browser CLI Reference

**ALWAYS use these Bash commands. NEVER use mcp__claude-in-chrome__* tools.**

```bash
# Navigation
agent-browser open <url>           # Navigate to URL
agent-browser back                 # Go back
agent-browser close                # Close browser

# Snapshots (get element refs)
agent-browser snapshot -i          # Interactive elements with refs (@e1, @e2, etc.)
agent-browser snapshot -i --json   # JSON output

# Interactions (use refs from snapshot)
agent-browser click @e1            # Click element
agent-browser fill @e1 "text"      # Fill input
agent-browser type @e1 "text"      # Type without clearing
agent-browser press Enter          # Press key

# Screenshots
agent-browser screenshot out.png       # Viewport screenshot
agent-browser screenshot --full out.png # Full page screenshot

# Headed mode (visible browser)
agent-browser --headed open <url>      # Open with visible browser
agent-browser --headed click @e1       # Click in visible browser

# Wait
agent-browser wait @e1             # Wait for element
agent-browser wait 2000            # Wait milliseconds
```
---

## Source: webapp-testing


# Web Application Testing

To test local web applications, write native Python Playwright scripts.

**Helper Scripts Available**:
- `scripts/with_server.py` - Manages server lifecycle (supports multiple servers)

**Always run scripts with `--help` first** to see usage. DO NOT read the source until you try running the script first and find that a customized solution is abslutely necessary. These scripts can be very large and thus pollute your context window. They exist to be called directly as black-box scripts rather than ingested into your context window.

## Decision Tree: Choosing Your Approach

```
User task → Is it static HTML?
    ├─ Yes → Read HTML file directly to identify selectors
    │         ├─ Success → Write Playwright script using selectors
    │         └─ Fails/Incomplete → Treat as dynamic (below)
    │
    └─ No (dynamic webapp) → Is the server already running?
        ├─ No → Run: python scripts/with_server.py --help
        │        Then use the helper + write simplified Playwright script
        │
        └─ Yes → Reconnaissance-then-action:
            1. Navigate and wait for networkidle
            2. Take screenshot or inspect DOM
            3. Identify selectors from rendered state
            4. Execute actions with discovered selectors
```

## Example: Using with_server.py

To start a server, run `--help` first, then use the helper:

**Single server:**
```bash
python scripts/with_server.py --server "npm run dev" --port 5173 -- python your_automation.py
```

**Multiple servers (e.g., backend + frontend):**
```bash
python scripts/with_server.py \
  --server "cd backend && python server.py" --port 3000 \
  --server "cd frontend && npm run dev" --port 5173 \
  -- python your_automation.py
```

To create an automation script, include only Playwright logic (servers are managed automatically):
```python
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True) # Always launch chromium in headless mode
    page = browser.new_page()
    page.goto('http://localhost:5173') # Server already running and ready
    page.wait_for_load_state('networkidle') # CRITICAL: Wait for JS to execute
    # ... your automation logic
    browser.close()
```

## Reconnaissance-Then-Action Pattern

1. **Inspect rendered DOM**:
   ```python
   page.screenshot(path='/tmp/inspect.png', full_page=True)
   content = page.content()
   page.locator('button').all()
   ```

2. **Identify selectors** from inspection results

3. **Execute actions** using discovered selectors

## Common Pitfall

❌ **Don't** inspect the DOM before waiting for `networkidle` on dynamic apps
✅ **Do** wait for `page.wait_for_load_state('networkidle')` before inspection

## Best Practices

- **Use bundled scripts as black boxes** - To accomplish a task, consider whether one of the scripts available in `scripts/` can help. These scripts handle common, complex workflows reliably without cluttering the context window. Use `--help` to see usage, then invoke directly. 
- Use `sync_playwright()` for synchronous scripts
- Always close the browser when done
- Use descriptive selectors: `text=`, `role=`, CSS selectors, or IDs
- Add appropriate waits: `page.wait_for_selector()` or `page.wait_for_timeout()`

## Reference Files

- **examples/** - Examples showing common patterns:
  - `element_discovery.py` - Discovering buttons, links, and inputs on a page
  - `static_html_automation.py` - Using file:// URLs for local HTML
  - `console_logging.py` - Capturing console logs during automation---

## Source: playwright-expert


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

## Source: playwright-expert/references / api-mocking.md

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

## Source: playwright-expert/references / configuration.md

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

## Source: playwright-expert/references / debugging-flaky.md

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

## Source: playwright-expert/references / page-object-model.md

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

## Source: playwright-expert/references / selectors-locators.md

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
