---
name: testing-verification
description: "This skill should be used when the user asks to write tests, do TDD, fix failing tests, debug a bug, set up Playwright, run E2E tests, verify work before shipping, or evaluate output quality. Covers test-driven development, test infrastructure, systematic debugging, verification loops, and quality gates. Use this skill even for tangential mentions of testing, TDD, debugging, verification, or quality assurance."
metadata:
  priority: 60
  promptSignals:
    phrases:
      - 'write tests'
      - 'TDD'
      - 'fix failing test'
      - 'Playwright'
      - 'E2E test'
      - 'verify before shipping'
      - 'test coverage'
      - 'debug this bug'
      - 'quality gate'
---

# Testing & Verification — Chief Skill

> Unified brain for TDD, test infrastructure, debugging, and verification workflows.

## Decision Tree

```
Testing/quality task arrives
│
├─ "Write tests" or "TDD" or test-first development
│   └── READ 01-tdd-methodology.md
│
├─ "E2E test" or "Playwright" or "browser test" or test infrastructure
│   └── READ 02-test-infrastructure.md
│
├─ "Debug" or "fix bug" or "error" or "stack trace"
│   └── READ 03-debugging.md
│
├─ "Visual regression" or "screenshot parity" or "golden reference"
│   └── READ 11-visual-regression-testing.md
│
└─ "Verify" or "quality gate" or "before shipping" or evaluation
    └── READ 04-verification.md
```

## Non-Negotiables

1. Write test FIRST (RED), implement SECOND (GREEN), refactor THIRD (IMPROVE)
2. Target 80%+ test coverage
3. Never fix tests to match broken code — fix the code
4. Verify before claiming work is complete

## Bundled References

| # | Reference | Load When |
|---|-----------|-----------|
| 01 | `01-tdd-methodology.md` | Writing tests, TDD workflow |
| 02 | `02-test-infrastructure.md` | E2E, Playwright, test frameworks |
| 03 | `03-debugging.md` | Bug investigation, stack traces |
| 04 | `04-verification.md` | Pre-ship verification, quality gates |
| 05 | `05-playwright-e2e.md` | Playwright selectors, page objects, fixtures, mocking |
| 06 | `06-tdd-workflow.md` | TDD activation, coverage targets, test organization |
| 07 | `07-verification-loop.md` | Build/type/lint/test/security verification sweep |
| 08 | `08-eval-harness.md` | Eval-driven development, pass@k, graders |
| 09 | `09-bug-workflows.md` | Report-bug / reproduce-bug command workflows |
| 10 | `10-xcode-testing.md` | iOS/macOS simulator build-and-test |
| 11 | `11-visual-regression-testing.md` | Visual/pixel parity, golden references, SSIM |