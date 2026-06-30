# Legacy Modernization
---

## Source: spec-miner/SKILL.md

---
name: spec-miner
description: "Reverse-engineering specialist that extracts specifications from existing codebases. Use when working with legacy or undocumented systems, inherited projects, or old codebases with no documentation. Invoke to map code dependencies, generate API documentation from source, identify undocumented business logic, figure out what code does, or create architecture documentation from implementation. Trigger phrases: reverse engineer, old codebase, no docs, no documentation, figure out how this works, inherited project, legacy analysis, code archaeology, undocumented features."
license: MIT
allowed-tools: Read, Grep, Glob, Bash
metadata:
  author: https://github.com/Jeffallan
  version: "1.1.0"
  domain: workflow
  triggers: reverse engineer, legacy code, code analysis, undocumented, understand codebase, existing system
  role: specialist
  scope: review
  output-format: document
  related-skills: feature-forge, fullstack-guardian, architecture-designer
---

# Spec Miner

Reverse-engineering specialist who extracts specifications from existing codebases.

## Role Definition

You operate with two perspectives: **Arch Hat** for system architecture and data flows, and **QA Hat** for observable behaviors and edge cases.

## When to Use This Skill

- Understanding legacy or undocumented systems
- Creating documentation for existing code
- Onboarding to a new codebase
- Planning enhancements to existing features
- Extracting requirements from implementation

## Core Workflow

1. **Scope** - Identify analysis boundaries (full system or specific feature)
2. **Explore** - Map structure using Glob, Grep, Read tools
   - _Validation checkpoint:_ Confirm sufficient file coverage before proceeding. If key entry points, configuration files, or core modules remain unread, continue exploration before writing documentation.
3. **Trace** - Follow data flows and request paths
4. **Document** - Write observed requirements in EARS format
5. **Flag** - Mark areas needing clarification

### Example Exploration Patterns

```
# Find entry points and public interfaces
Glob('**/*.py', exclude=['**/test*', '**/__pycache__/**'])

# Locate technical debt markers
Grep('TODO|FIXME|HACK|XXX', include='*.py')

# Discover configuration and environment usage
Grep('os\.environ|config\[|settings\.', include='*.py')

# Map API route definitions (Flask/Django/Express examples)
Grep('@app\.route|@router\.|router\.get|router\.post', include='*.py')
```

### EARS Format Quick Reference

EARS (Easy Approach to Requirements Syntax) structures observed behavior as:

| Type | Pattern | Example |
|------|---------|---------|
| Ubiquitous | The `<system>` shall `<action>`. | The API shall return JSON responses. |
| Event-driven | When `<trigger>`, the `<system>` shall `<action>`. | When a request lacks an auth token, the system shall return HTTP 401. |
| State-driven | While `<state>`, the `<system>` shall `<action>`. | While in maintenance mode, the system shall reject all write operations. |
| Optional | Where `<feature>` is supported, the `<system>` shall `<action>`. | Where caching is enabled, the system shall store responses for 60 seconds. |

> See `references/ears-format.md` for the complete EARS reference.

## Reference Guide

Load detailed guidance based on context:

| Topic | Reference | Load When |
|-------|-----------|-----------|
| Analysis Process | `references/analysis-process.md` | Starting exploration, Glob/Grep patterns |
| EARS Format | `references/ears-format.md` | Writing observed requirements |
| Specification Template | `references/specification-template.md` | Creating final specification document |
| Analysis Checklist | `references/analysis-checklist.md` | Ensuring thorough analysis |

## Constraints

### MUST DO
- Ground all observations in actual code evidence
- Use Read, Grep, Glob extensively to explore
- Distinguish between observed facts and inferences
- Document uncertainties in dedicated section
- Include code locations for each observation

### MUST NOT DO
- Make assumptions without code evidence
- Skip security pattern analysis
- Ignore error handling patterns
- Generate spec without thorough exploration

## Output Templates

Save specification as: `specs/{project_name}_reverse_spec.md`

Include:
1. Technology stack and architecture
2. Module/directory structure
3. Observed requirements (EARS format)
4. Non-functional observations
5. Inferred acceptance criteria
6. Uncertainties and questions
7. Recommendations

---

## Source: spec-miner/analysis-checklist.md

# Analysis Checklist

## Comprehensive Checklist

| Area | What to Find | Glob/Grep Patterns |
|------|--------------|-------------------|
| **Entry points** | main.ts, app.ts, index.ts | `**/main.{ts,js,py}` |
| **Routes** | Controllers, route files | `**/routes/**/*`, `@Controller` |
| **Models** | Entities, schemas | `**/models/**/*`, `@Entity` |
| **Auth** | Guards, middleware, JWT | `**/auth/**/*`, `passport` |
| **Validation** | DTOs, validators, pipes | `**/dto/**/*`, `@IsString` |
| **Error handling** | Exception filters, try/catch | `ExceptionFilter`, `catch` |
| **External calls** | HTTP clients, SDK usage | `fetch(`, `axios.` |
| **Config** | Env files, config modules | `**/.env*`, `ConfigService` |
| **Tests** | Test files reveal behaviors | `**/*.spec.ts`, `**/*.test.ts` |
| **Background jobs** | Queues, cron, workers | `@Cron`, `Bull`, `Queue` |

## Analysis Phases

### Phase 1: Structure Discovery
- [ ] Identify technology stack
- [ ] Map directory structure
- [ ] Find entry points
- [ ] List all modules/packages

### Phase 2: API Surface
- [ ] Document all endpoints
- [ ] Note HTTP methods and paths
- [ ] Identify request/response formats
- [ ] Find authentication requirements

### Phase 3: Data Layer
- [ ] Map all data models
- [ ] Document relationships
- [ ] Find migrations
- [ ] Note validation rules

### Phase 4: Business Logic
- [ ] Trace main flows
- [ ] Identify business rules
- [ ] Document state transitions
- [ ] Find external integrations

### Phase 5: Security
- [ ] Check authentication method
- [ ] Review authorization patterns
- [ ] Find input validation
- [ ] Note security configurations

### Phase 6: Quality & Testing
- [ ] Review existing tests
- [ ] Note test coverage
- [ ] Document error handling
- [ ] Find logging patterns

## Verification Questions

Before finalizing specification:

- [ ] All endpoints documented?
- [ ] All models mapped?
- [ ] Authentication flow clear?
- [ ] Error responses documented?
- [ ] External dependencies listed?
- [ ] Uncertainties flagged?

---

## Source: spec-miner/analysis-process.md

# Analysis Process

## Step 1: Project Structure

```bash
# Find entry points
Glob: **/main.{ts,js,py,go}
Glob: **/app.{ts,js,py}
Glob: **/index.{ts,js}

# Find routes/controllers
Glob: **/routes/**/*.{ts,js}
Glob: **/controllers/**/*.{ts,js}
Grep: @Controller|@Get|@Post|router\.|app\.get
```

## Step 2: Data Models

```bash
# Database schemas
Glob: **/models/**/*.{ts,js,py}
Glob: **/schema*.{ts,js,py,sql}
Glob: **/migrations/**/*
Grep: @Entity|class.*Model|schema\s*=
```

## Step 3: Business Logic

```bash
# Services and logic
Glob: **/services/**/*.{ts,js}
Grep: async.*function|export.*class
```

## Step 4: Authentication & Security

```bash
# Auth patterns
Glob: **/auth/**/*
Glob: **/guards/**/*
Grep: @Guard|middleware|passport|jwt
```

## Step 5: External Integrations

```bash
# External calls
Grep: fetch\(|axios\.|HttpService|request\(
Glob: **/integrations/**/*
Glob: **/clients/**/*
```

## Step 6: Configuration

```bash
# Config files
Glob: **/*.config.{ts,js}
Glob: **/.env*
Glob: **/config/**/*
```

## Quick Reference

| Pattern | Purpose |
|---------|---------|
| `**/main.{ts,js,py}` | Entry points |
| `**/routes/**/*` | API routes |
| `**/models/**/*` | Data models |
| `@Controller\|@Get` | NestJS patterns |
| `router.\|app.get` | Express patterns |

---

## Source: spec-miner/ears-format.md

# EARS Format

## EARS Syntax

Easy Approach to Requirements Syntax for clear, unambiguous requirements.

### Basic Patterns

**Ubiquitous (Always)**
```
The system shall [action].
```

**Event-Driven**
```
When [trigger], the system shall [action].
```

**State-Driven**
```
While [state], the system shall [action].
```

**Conditional**
```
While [state], when [trigger], the system shall [action].
```

**Optional**
```
Where [feature enabled], the system shall [action].
```

## Example Observations

### Authentication

**OBS-AUTH-001: Login Flow**
```
While credentials are valid, when POST /auth/login is called,
the system shall return JWT access token (15m) and refresh token (7d).
```

**OBS-AUTH-002: Token Refresh**
```
While refresh token is valid, when POST /auth/refresh is called,
the system shall issue new access token.
```

**OBS-AUTH-003: Invalid Token**
```
When expired or invalid token is provided,
the system shall return 401 Unauthorized.
```

### User Management

**OBS-USER-001: User Creation**
```
While email is unique, when POST /users is called with valid data,
the system shall create user with bcrypt-hashed password (rounds=12).
```

**OBS-USER-002: Email Validation**
```
When email format is invalid,
the system shall return 400 with error message "Invalid email format".
```

### Input Validation

**OBS-INPUT-001: Required Fields**
```
When required fields are missing,
the system shall return 400 with field-specific error messages.
```

## Quick Reference

| Type | Pattern | Example Trigger |
|------|---------|-----------------|
| Ubiquitous | shall [action] | Always true |
| Event | When [X], shall | On button click |
| State | While [X], shall | While logged in |
| Conditional | While [X], when [Y], shall | While admin, when delete |
| Optional | Where [X], shall | If feature enabled |

---

## Source: spec-miner/specification-template.md

# Specification Template

## Full Template

```markdown
# Reverse-Engineered Specification: [System/Feature Name]

## Overview
[High-level description based on analysis]

## Architecture Summary

### Technology Stack
- **Language**: TypeScript 5.x
- **Framework**: NestJS 10.x
- **Database**: PostgreSQL 15
- **ORM**: Prisma 5.x

### Module Structure
```
src/
├── auth/         # Authentication (JWT, guards)
├── users/        # User CRUD operations
├── orders/       # Order processing
└── common/       # Shared utilities
```

### Data Flow
```
Request → Guard → Controller → Service → Repository → Database
                                     ↓
                              External APIs
```

## Observed Functional Requirements

### [Module Name]

**OBS-XXX-001**: [Feature Name]
[EARS format requirement]

**OBS-XXX-002**: [Feature Name]
[EARS format requirement]

## Observed Non-Functional Requirements

### Security
- JWT tokens signed with RS256
- Passwords hashed with bcrypt (12 rounds)
- Rate limiting: 100 req/min per IP

### Performance
- Database connection pool: 10 connections
- Response timeout: 30 seconds
- Pagination: default 20, max 100

### Error Handling
| Code | Condition | Response |
|------|-----------|----------|
| 400 | Validation failure | `{ error: string, details: object }` |
| 401 | Invalid/missing token | `{ error: "Unauthorized" }` |
| 404 | Resource not found | `{ error: "Not found" }` |
| 500 | Unhandled error | `{ error: "Internal server error" }` |

## Inferred Acceptance Criteria

### AC-001: [Feature]
Given [precondition]
When [action]
Then [expected result]

## Uncertainties and Questions

- [ ] What triggers order status transitions?
- [ ] Is soft delete implemented for users?
- [ ] What external APIs are called?
- [ ] Are there background jobs?

## Recommendations

1. Add OpenAPI documentation to controllers
2. Missing input validation on PATCH endpoints
3. Consider adding request tracing
```

## Output Location

Save specification as: `specs/{project_name}_reverse_spec.md`

## Required Sections

| Section | Purpose |
|---------|---------|
| Overview | High-level summary |
| Architecture | Tech stack, structure, data flow |
| Functional Requirements | EARS format observations |
| Non-Functional | Security, performance, errors |
| Acceptance Criteria | Given/When/Then format |
| Uncertainties | Questions for clarification |
| Recommendations | Improvements identified |

---

## Source: legacy-modernizer/SKILL.md

---
name: legacy-modernizer
description: Designs incremental migration strategies, identifies service boundaries, produces dependency maps and migration roadmaps, and generates API facade designs for aging codebases. Use when modernizing legacy systems, implementing strangler fig pattern or branch by abstraction, decomposing monoliths, upgrading frameworks or languages, or reducing technical debt without disrupting business operations.
license: MIT
metadata:
  author: https://github.com/Jeffallan
  version: "1.1.0"
  domain: specialized
  triggers: legacy modernization, strangler fig, incremental migration, technical debt, legacy refactoring, system migration, legacy system, modernize codebase
  role: specialist
  scope: architecture
  output-format: code+analysis
  related-skills: test-master, devops-engineer
---

# Legacy Modernizer

## Core Workflow

1. **Assess system** — Analyze codebase, dependencies, risks, and business constraints. Produce a dependency map and risk register before proceeding.
   - *Validation checkpoint:* Confirm all external integrations and data contracts are documented before moving to step 2.

2. **Plan migration** — Design an incremental roadmap with explicit rollback strategies per phase. Reference `references/system-assessment.md` for code analysis templates.
   - *Validation checkpoint:* Confirm each phase has a defined rollback trigger and owner.

3. **Build safety net** — Create characterization tests and monitoring before touching production code. Target 80%+ coverage of existing behavior.
   - *Validation checkpoint:* Run the characterization test suite and confirm it passes green on the unmodified legacy system before proceeding.

4. **Migrate incrementally** — Apply strangler fig pattern with feature flags. Route traffic via a facade; shift load gradually.
   - *Validation checkpoint:* Verify error rates and latency metrics remain within baseline thresholds after each traffic increment (e.g., 5% → 25% → 50% → 100%).

5. **Validate & iterate** — Run full test suite, review monitoring dashboards, and confirm business behavior is preserved before retiring legacy code.
   - *Validation checkpoint:* New code must be proven stable at 100% traffic for at least one release cycle before legacy path is removed.

## Reference Guide

Load detailed guidance based on context:

| Topic | Reference | Load When |
|-------|-----------|-----------|
| Strangler Fig | `references/strangler-fig-pattern.md` | Incremental replacement, facade layer, routing |
| Refactoring | `references/refactoring-patterns.md` | Extract service, branch by abstraction, adapters |
| Migration | `references/migration-strategies.md` | Database, UI, API, framework migrations |
| Testing | `references/legacy-testing.md` | Characterization tests, golden master, approval |
| Assessment | `references/system-assessment.md` | Code analysis, dependency mapping, risk evaluation |

## Code Examples

### Strangler Fig Facade (Python)
```python
# facade.py — routes requests to legacy or new service based on a feature flag
import os
from legacy_service import LegacyOrderService
from new_service import NewOrderService

class OrderServiceFacade:
    def __init__(self):
        self._legacy = LegacyOrderService()
        self._new = NewOrderService()

    def get_order(self, order_id: str):
        if os.getenv("USE_NEW_ORDER_SERVICE", "false").lower() == "true":
            return self._new.fetch(order_id)
        return self._legacy.get(order_id)
```

### Feature Flag Wrapper
```python
# feature_flags.py — thin wrapper around an environment or config-based flag store
import os

def flag_enabled(flag_name: str, default: bool = False) -> bool:
    """Check whether a migration feature flag is active."""
    return os.getenv(flag_name, str(default)).lower() == "true"

# Usage
if flag_enabled("USE_NEW_PAYMENT_GATEWAY"):
    result = new_gateway.charge(order)
else:
    result = legacy_gateway.charge(order)
```

### Characterization Test Template (pytest)
```python
# test_characterization_orders.py
# Captures existing legacy behavior as a golden-master safety net.
import pytest
from legacy_service import LegacyOrderService

service = LegacyOrderService()

@pytest.mark.parametrize("order_id,expected_status", [
    ("ORD-001", "SHIPPED"),
    ("ORD-002", "PENDING"),
    ("ORD-003", "CANCELLED"),
])
def test_order_status_golden_master(order_id, expected_status):
    """Fail loudly if legacy behavior changes unexpectedly."""
    result = service.get(order_id)
    assert result["status"] == expected_status, (
        f"Characterization broken for {order_id}: "
        f"expected {expected_status}, got {result['status']}"
    )
```

## Constraints

### MUST DO
- Maintain zero production disruption during all migrations
- Create comprehensive test coverage before refactoring (target 80%+)
- Use feature flags for all incremental rollouts
- Implement monitoring and rollback procedures
- Document all migration decisions and rationale
- Preserve existing business logic and behavior
- Communicate progress and risks transparently

### MUST NOT DO
- Big bang rewrites or replacements
- Skip testing legacy behavior before changes
- Deploy without rollback capability
- Break existing integrations or APIs
- Ignore technical debt in new code
- Rush migrations without proper validation
- Remove legacy code before new code is proven

## Output Templates

When implementing modernization, provide:
1. Assessment summary (risks, dependencies, approach)
2. Migration plan (phases, rollback strategy, metrics)
3. Implementation code (facades, adapters, new services)
4. Test coverage (characterization, integration, e2e)
5. Monitoring setup (metrics, alerts, dashboards)

## Knowledge Reference

Strangler fig pattern, branch by abstraction, characterization testing, incremental migration, feature flags, canary deployments, API versioning, database refactoring, microservices extraction, technical debt reduction, zero-downtime deployment

---

## Source: legacy-modernizer/legacy-testing.md

# Legacy Testing Strategies

## Characterization Tests

Tests that document current behavior (even if buggy) before refactoring.

```python
# Legacy function with unknown behavior
def calculate_shipping_cost(order):
    """Legacy shipping calculator - behavior unclear"""
    cost = 0
    if order['weight'] > 10:
        cost += order['weight'] * 0.5
    if order['destination'] == 'international':
        cost *= 2
    if order['priority']:
        cost *= 1.5
    # ... more mysterious logic
    return round(cost, 2)

# Characterization test: Capture current behavior
import pytest

class TestShippingCostCharacterization:
    """These tests document existing behavior, not correct behavior"""

    def test_domestic_lightweight(self):
        order = {'weight': 5, 'destination': 'domestic', 'priority': False}
        # This IS the current behavior (0.0 might be wrong!)
        assert calculate_shipping_cost(order) == 0.0

    def test_domestic_heavy(self):
        order = {'weight': 15, 'destination': 'domestic', 'priority': False}
        assert calculate_shipping_cost(order) == 7.5  # weight * 0.5

    def test_international_heavy(self):
        order = {'weight': 15, 'destination': 'international', 'priority': False}
        assert calculate_shipping_cost(order) == 15.0  # (15 * 0.5) * 2

    def test_priority_international_heavy(self):
        order = {'weight': 15, 'destination': 'international', 'priority': True}
        assert calculate_shipping_cost(order) == 22.5  # ((15 * 0.5) * 2) * 1.5

# After characterization, refactor with confidence
def calculate_shipping_cost_v2(order: Order) -> Decimal:
    """Refactored with clear logic"""
    base_cost = Decimal('0')

    if order.weight > 10:
        base_cost = Decimal(str(order.weight)) * Decimal('0.5')

    if order.destination == Destination.INTERNATIONAL:
        base_cost *= Decimal('2')

    if order.priority:
        base_cost *= Decimal('1.5')

    return base_cost.quantize(Decimal('0.01'))

# Characterization tests should still pass
```

## Golden Master Testing

Capture output snapshots for complex legacy systems.

```python
# Legacy report generator with complex formatting
def generate_monthly_report(start_date, end_date):
    """Generates complex text report"""
    report = []
    report.append(f"Report Period: {start_date} to {end_date}")
    # ... 500 lines of complex logic
    return "\n".join(report)

# Golden master test
import hashlib
import os
from pathlib import Path

class TestMonthlyReportGoldenMaster:
    def test_january_2024_report(self):
        """Compare against known-good output"""
        report = generate_monthly_report('2024-01-01', '2024-01-31')

        # First run: Save golden master
        golden_path = Path(__file__).parent / 'golden_masters' / 'jan_2024.txt'
        if not golden_path.exists():
            golden_path.parent.mkdir(exist_ok=True)
            golden_path.write_text(report)
            pytest.skip("Golden master saved, run again to verify")

        # Subsequent runs: Compare
        expected = golden_path.read_text()
        assert report == expected, "Output differs from golden master"

    def test_report_hash_unchanged(self):
        """Faster comparison using hash"""
        report = generate_monthly_report('2024-01-01', '2024-01-31')
        report_hash = hashlib.sha256(report.encode()).hexdigest()

        # Known good hash
        expected_hash = "a3f5b2c8d9e1f4a7b6c5d8e9f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0"
        assert report_hash == expected_hash

# Approval testing library
from approvaltests import verify

def test_monthly_report_approval():
    """Uses approvaltests library for easy golden master testing"""
    report = generate_monthly_report('2024-01-01', '2024-01-31')
    verify(report)  # Creates .approved file first run, compares after
```

## Snapshot Testing for APIs

```python
# Legacy API with complex responses
@app.get("/api/dashboard")
async def get_dashboard():
    # Complex aggregation logic
    return {
        "user": {...},
        "stats": {...},
        "notifications": [...],
        # ... many nested fields
    }

# Snapshot test
import pytest
from syrupy import SnapshotAssertion

@pytest.mark.asyncio
async def test_dashboard_structure(snapshot: SnapshotAssertion):
    """Ensure dashboard structure doesn't change unexpectedly"""
    response = await client.get("/api/dashboard")

    # First run creates snapshot, subsequent runs compare
    assert response.json() == snapshot

# Custom snapshot serializer for stable output
from syrupy.extensions.json import JSONSnapshotExtension

class SortedJSONExtension(JSONSnapshotExtension):
    def serialize(self, data, **kwargs):
        # Sort keys for consistent snapshots
        return super().serialize(data, sort_keys=True, **kwargs)

@pytest.fixture
def snapshot(snapshot):
    return snapshot.use_extension(SortedJSONExtension)
```

## Parallel Run Testing

Run old and new implementations side-by-side to compare.

```python
# Parallel run decorator
import functools
import asyncio
from typing import Callable, Any

def parallel_run(legacy_func: Callable, new_func: Callable):
    """Run both implementations and compare results"""
    @functools.wraps(new_func)
    async def wrapper(*args, **kwargs):
        # Run both in parallel
        legacy_task = asyncio.create_task(
            asyncio.to_thread(legacy_func, *args, **kwargs)
        )
        new_task = asyncio.create_task(new_func(*args, **kwargs))

        legacy_result, new_result = await asyncio.gather(
            legacy_task, new_task, return_exceptions=True
        )

        # Log discrepancies
        if legacy_result != new_result:
            logger.warning(
                "Parallel run mismatch",
                extra={
                    "function": new_func.__name__,
                    "args": args,
                    "legacy_result": legacy_result,
                    "new_result": new_result,
                }
            )

        # Use legacy result in production (new is shadow)
        if isinstance(legacy_result, Exception):
            raise legacy_result
        return legacy_result

    return wrapper

# Usage
@parallel_run(legacy_func=legacy_calculate_price, new_func=new_calculate_price)
async def calculate_price(product_id: int, quantity: int):
    """This will run both and compare results"""
    pass

# In production, route to parallel_run
@app.get("/price/{product_id}")
async def get_price(product_id: int, quantity: int = 1):
    return await calculate_price(product_id, quantity)
```

## Mutation Testing for Legacy Code

```python
# Install: pip install mutmut

# Legacy function we want to refactor
def validate_email(email):
    if '@' not in email:
        return False
    if '.' not in email:
        return False
    if len(email) < 5:
        return False
    return True

# Basic tests
def test_validate_email():
    assert validate_email("user@example.com") is True
    assert validate_email("invalid") is False

# Run mutation testing to find missing test cases
# $ mutmut run --paths-to-mutate=validate.py

# Mutmut will create mutations like:
# - Change '@' to '!' (caught by test)
# - Change 5 to 6 (NOT caught - missing edge case!)
# - Remove conditions (caught by test)

# Add missing test cases discovered by mutation testing
def test_validate_email_comprehensive():
    # Original tests
    assert validate_email("user@example.com") is True
    assert validate_email("invalid") is False

    # Edge cases found by mutation testing
    assert validate_email("a@b.c") is True   # Exactly 5 chars
    assert validate_email("a@b.") is False   # Dot at end
    assert validate_email(".@b.c") is False  # Dot at start
    assert validate_email("a@.com") is False # Dot after @
```

## Property-Based Testing for Legacy Logic

```python
from hypothesis import given, strategies as st

# Legacy function with unclear edge cases
def calculate_discount(price, quantity, customer_type):
    """Legacy discount logic"""
    discount = 0
    if quantity > 10:
        discount += 0.1
    if customer_type == 'premium':
        discount += 0.15
    if price > 1000:
        discount += 0.05
    return price * (1 - min(discount, 0.5))

# Property-based tests discover edge cases
@given(
    price=st.floats(min_value=0.01, max_value=100000),
    quantity=st.integers(min_value=1, max_value=1000),
    customer_type=st.sampled_from(['regular', 'premium']),
)
def test_discount_properties(price, quantity, customer_type):
    result = calculate_discount(price, quantity, customer_type)

    # Property: Result should never be negative
    assert result >= 0

    # Property: Result should never exceed original price
    assert result <= price

    # Property: Discount should never exceed 50%
    assert result >= price * 0.5

# Run this 100+ times with random inputs
# Hypothesis will find edge cases that break these properties
```

## Coverage-Guided Test Generation

```python
# Use coverage.py to find untested code paths
# $ pytest --cov=legacy_module --cov-report=html

# Example: Legacy function with many branches
def process_order(order):
    if not order.get('items'):
        raise ValueError("Empty order")

    total = sum(item['price'] * item['qty'] for item in order['items'])

    if order.get('coupon'):
        discount = apply_coupon(order['coupon'], total)
        total -= discount

    if order.get('shipping_method') == 'express':
        total += 25
    elif order.get('shipping_method') == 'international':
        total += 50

    if total < 0:  # This line never tested!
        total = 0

    return {'total': total, 'order_id': generate_id()}

# Coverage report shows line "total = 0" never executed
# Add test case:
def test_process_order_negative_total():
    """Test case discovered from coverage analysis"""
    order = {
        'items': [{'price': 10, 'qty': 1}],
        'coupon': 'SUPER_DISCOUNT_100',  # 100% off
    }
    result = process_order(order)
    assert result['total'] == 0  # Should handle negative total
```

## Database State Testing

```python
# Test database-dependent legacy code
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

@pytest.fixture
def legacy_db():
    """Create test database matching legacy schema"""
    engine = create_engine("sqlite:///:memory:")

    # Recreate legacy schema (exact structure)
    engine.execute("""
        CREATE TABLE users (
            id INTEGER PRIMARY KEY,
            name TEXT,
            email TEXT,
            created TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)

    Session = sessionmaker(bind=engine)
    session = Session()

    yield session

    session.close()

def test_legacy_user_creation(legacy_db):
    """Test legacy code against test database"""
    # Insert using legacy code
    legacy_create_user(legacy_db, "John", "john@example.com")

    # Verify using raw SQL
    result = legacy_db.execute("SELECT * FROM users WHERE name = 'John'")
    user = result.fetchone()

    assert user is not None
    assert user['email'] == "john@example.com"
```

## Quick Reference

| Test Type | Use When | Tool |
|-----------|----------|------|
| Characterization | Unknown behavior | pytest |
| Golden Master | Complex output | approvaltests |
| Snapshot | API responses | syrupy |
| Parallel Run | Comparing implementations | Custom decorator |
| Mutation | Finding gaps | mutmut |
| Property-based | Edge cases | hypothesis |
| Coverage-guided | Untested paths | coverage.py |

---

## Source: legacy-modernizer/migration-strategies.md

# Migration Strategies

## Database Migration Strategy

### Dual-Write Pattern

```python
# Phase 1: Dual write to both databases
class DualWriteUserRepository:
    def __init__(self, legacy_db, modern_db: AsyncSession):
        self.legacy = legacy_db
        self.modern = modern_db

    async def create_user(self, user_data: dict) -> User:
        # Write to modern DB (source of truth)
        async with self.modern.begin():
            user = User(**user_data)
            self.modern.add(user)
            await self.modern.flush()

        # Async write to legacy for backwards compatibility
        asyncio.create_task(self._sync_to_legacy(user))

        return user

    async def _sync_to_legacy(self, user: User):
        try:
            await asyncio.to_thread(
                self.legacy.execute,
                "INSERT INTO users VALUES (?, ?, ?)",
                user.id, user.email, user.name,
            )
        except Exception as e:
            # Log but don't fail - modern DB is source of truth
            logger.error(f"Legacy sync failed: {e}", extra={"user_id": user.id})

# Phase 2: Dual read with lazy migration
async def get_user(self, user_id: int) -> User | None:
    # Try modern DB first
    user = await self.modern.get(User, user_id)
    if user:
        return user

    # Fallback to legacy, then migrate
    legacy_user = await self._read_from_legacy(user_id)
    if legacy_user:
        return await self._lazy_migrate(legacy_user)

    return None

async def _lazy_migrate(self, legacy_data: dict) -> User:
    """Migrate user from legacy to modern on read"""
    user = User(**legacy_data)
    async with self.modern.begin():
        self.modern.add(user)
        await self.modern.flush()
    return user

# Phase 3: Stop dual-write after 100% migrated
async def create_user(self, user_data: dict) -> User:
    if migration_complete:
        # Only write to modern DB
        return await self._create_modern(user_data)
    else:
        # Continue dual-write during migration
        return await self._create_dual_write(user_data)
```

### Schema Evolution

```python
# Expand-Contract pattern for schema changes
# Step 1: EXPAND - Add new column (nullable or default value)
"""
ALTER TABLE users ADD COLUMN email_verified BOOLEAN DEFAULT FALSE;
"""

# Step 2: WRITE BOTH - Application writes to both old and new
class User(Base):
    __tablename__ = "users"

    # Old field (deprecated)
    is_confirmed = Column(Boolean, default=False)

    # New field
    email_verified = Column(Boolean, default=False)

    def set_verified(self, verified: bool):
        # Write to both during migration
        self.email_verified = verified
        self.is_confirmed = verified  # Backwards compatibility

# Step 3: MIGRATE - Backfill existing data
"""
UPDATE users
SET email_verified = is_confirmed
WHERE email_verified IS NULL;
"""

# Step 4: READ NEW - Application reads from new column
@property
def is_email_verified(self) -> bool:
    # Prefer new field, fallback to old
    return self.email_verified or self.is_confirmed

# Step 5: CONTRACT - Remove old column (after all code deployed)
"""
ALTER TABLE users DROP COLUMN is_confirmed;
"""
```

## API Versioning Migration

```python
# Version 1: Legacy API
@app.get("/api/users/{user_id}")
async def get_user_v1(user_id: int):
    user = await users.get(user_id)
    return {
        "id": user.id,
        "name": user.name,
        "email": user.email,
        "created": user.created_at.isoformat(),
    }

# Version 2: New API with improved structure
@app.get("/api/v2/users/{user_id}")
async def get_user_v2(user_id: int):
    user = await users.get(user_id)
    return {
        "data": {
            "id": user.id,
            "type": "user",
            "attributes": {
                "name": user.name,
                "email": user.email,
            },
            "metadata": {
                "created_at": user.created_at.isoformat(),
                "updated_at": user.updated_at.isoformat(),
            },
        }
    }

# Content negotiation for gradual migration
@app.get("/api/users/{user_id}")
async def get_user(
    user_id: int,
    accept_version: str = Header(default="1"),
):
    user = await users.get(user_id)

    if accept_version == "2":
        return format_user_v2(user)
    else:
        return format_user_v1(user)

# Deprecation headers
response.headers["X-API-Deprecation"] = "V1 deprecated, migrate to V2"
response.headers["X-API-Sunset"] = "2024-12-31"
```

## Framework Migration (Flask to FastAPI)

```python
# Original Flask code
from flask import Flask, request, jsonify

flask_app = Flask(__name__)

@flask_app.route("/users", methods=["POST"])
def create_user():
    data = request.get_json()
    user = User(**data)
    db.session.add(user)
    db.session.commit()
    return jsonify(user.to_dict()), 201

# Step 1: Run both frameworks (different ports)
# Step 2: Create FastAPI equivalent
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

fastapi_app = FastAPI()

class UserCreate(BaseModel):
    email: str
    name: str

@fastapi_app.post("/users", status_code=201)
async def create_user(user_data: UserCreate):
    async with db.begin():
        user = User(**user_data.model_dump())
        db.add(user)
        await db.flush()
        return user.to_dict()

# Step 3: Proxy layer routes traffic between frameworks
from fastapi import Request
import httpx

@fastapi_app.api_route("/{path:path}", methods=["GET", "POST", "PUT", "DELETE"])
async def proxy_to_flask(request: Request, path: str):
    """Route unmigrated endpoints to Flask"""
    migrated_endpoints = {"/users", "/orders", "/products"}

    if f"/{path}" in migrated_endpoints:
        # Handle in FastAPI (new)
        return await handle_in_fastapi(request, path)
    else:
        # Proxy to Flask (legacy)
        async with httpx.AsyncClient() as client:
            response = await client.request(
                method=request.method,
                url=f"http://localhost:5000/{path}",
                content=await request.body(),
                headers=dict(request.headers),
            )
            return Response(
                content=response.content,
                status_code=response.status_code,
                headers=dict(response.headers),
            )

# Step 4: Gradually migrate endpoints, update routing
# Step 5: Shutdown Flask once all endpoints migrated
```

## Frontend Migration (jQuery to React)

```javascript
// Step 1: Load both frameworks
// index.html
<script src="jquery.min.js"></script>
<script src="legacy-app.js"></script>
<div id="react-root"></div>
<script src="react-bundle.js"></script>

// Step 2: Create React wrapper for legacy components
function LegacyWrapper({ selector, onMount }) {
  const ref = useRef(null);

  useEffect(() => {
    if (ref.current) {
      // Initialize legacy jQuery component
      $(ref.current).find(selector).legacyPlugin();
      onMount?.();
    }

    return () => {
      // Cleanup
      $(ref.current).find(selector).legacyPlugin('destroy');
    };
  }, [selector]);

  return <div ref={ref} dangerouslySetInnerHTML={{ __html: getLegacyHTML() }} />;
}

// Step 3: Replace components incrementally
function UserTable() {
  const useLegacy = !useFeatureFlag('react-user-table');

  if (useLegacy) {
    return <LegacyWrapper selector="#user-table" />;
  }

  // Modern React component
  return (
    <Table>
      {users.map(user => (
        <UserRow key={user.id} user={user} />
      ))}
    </Table>
  );
}

// Step 4: Share state between jQuery and React
window.appState = new Proxy({
  currentUser: null,
  notifications: [],
}, {
  set(target, prop, value) {
    target[prop] = value;
    // Notify React of changes
    window.dispatchEvent(new CustomEvent('appStateChange', {
      detail: { prop, value }
    }));
    return true;
  }
});

// React hook to sync with global state
function useAppState(key) {
  const [value, setValue] = useState(window.appState[key]);

  useEffect(() => {
    function handleChange(e) {
      if (e.detail.prop === key) {
        setValue(e.detail.value);
      }
    }
    window.addEventListener('appStateChange', handleChange);
    return () => window.removeEventListener('appStateChange', handleChange);
  }, [key]);

  return value;
}
```

## Microservices Extraction

```python
# Monolith with tightly coupled modules
class MonolithApp:
    def process_order(self, order_data):
        # Payment logic
        payment = self.charge_card(order_data['card'])

        # Inventory logic
        self.update_inventory(order_data['items'])

        # Notification logic
        self.send_email(order_data['user_email'])

# Step 1: Identify bounded contexts and extract
# New Payment Service (separate codebase/deployment)
from fastapi import FastAPI

payment_service = FastAPI()

@payment_service.post("/payments")
async def process_payment(payment: PaymentRequest):
    charge = await stripe.create_charge(payment.amount, payment.card)
    await db.save_payment(charge.id, payment.order_id)
    return {"payment_id": charge.id}

# Step 2: Modify monolith to call extracted service
class MonolithApp:
    def __init__(self, payment_client: PaymentClient):
        self.payment_client = payment_client

    async def process_order(self, order_data):
        # Call payment microservice instead of local code
        payment = await self.payment_client.process_payment(
            amount=order_data['total'],
            card=order_data['card'],
            order_id=order_data['id'],
        )

        # Rest still in monolith (for now)
        self.update_inventory(order_data['items'])
        self.send_email(order_data['user_email'])

# Step 3: Event-driven communication
# Payment service publishes events
@payment_service.post("/payments")
async def process_payment(payment: PaymentRequest):
    charge = await stripe.create_charge(payment.amount, payment.card)

    # Publish event instead of direct coupling
    await event_bus.publish("payment.completed", {
        "payment_id": charge.id,
        "order_id": payment.order_id,
        "amount": payment.amount,
    })

    return {"payment_id": charge.id}

# Inventory service subscribes to events
@event_bus.subscribe("payment.completed")
async def handle_payment_completed(event):
    order = await orders.get(event['order_id'])
    await inventory.reduce_stock(order.items)

# Monolith is now just orchestration
async def process_order(order_data):
    # Fire and forget - services are autonomous
    await event_bus.publish("order.created", order_data)
```

## Language Version Upgrade (Python 2 to 3)

```python
# Use six library for compatibility during migration
import six

# Works in both Python 2 and 3
if six.PY2:
    from urllib2 import urlopen
else:
    from urllib.request import urlopen

# Gradual type hint adoption
def process_user(user_id):  # type: (int) -> dict
    """Python 2 compatible type hints"""
    return {"id": user_id}

# After Python 3 only
def process_user(user_id: int) -> dict:
    """Modern type hints"""
    return {"id": user_id}

# String handling migration
# Python 2
user_name = unicode(raw_name, 'utf-8')

# Compatibility
user_name = six.text_type(raw_name)

# Python 3
user_name = str(raw_name)
```

## Quick Reference

| Migration Type | Strategy | Key Considerations |
|----------------|----------|-------------------|
| Database | Dual-write, lazy migration | Data consistency, rollback |
| API | Versioning, content negotiation | Client migration timeline |
| Framework | Proxy, parallel run | Performance overhead |
| Frontend | Incremental, shared state | Bundle size, compatibility |
| Microservices | Extract, events | Network reliability, data |
| Language | Compatibility layer | Dependency updates |

---

## Source: legacy-modernizer/refactoring-patterns.md

# Refactoring Patterns

## Branch by Abstraction

Enables large refactorings to happen incrementally without breaking existing code.

```python
# Step 1: Create abstraction
from abc import ABC, abstractmethod

class PaymentProcessor(ABC):
    @abstractmethod
    async def process_payment(self, amount: float, card: str) -> str:
        """Returns transaction_id"""
        pass

# Step 2: Implement for legacy code
class LegacyPaymentProcessor(PaymentProcessor):
    async def process_payment(self, amount: float, card: str) -> str:
        # Wrap existing legacy function
        return await asyncio.to_thread(
            legacy_payment_system.charge_card, amount, card
        )

# Step 3: Implement new version
class StripePaymentProcessor(PaymentProcessor):
    def __init__(self, stripe_client):
        self.stripe = stripe_client

    async def process_payment(self, amount: float, card: str) -> str:
        charge = await self.stripe.charges.create(
            amount=int(amount * 100),
            currency="usd",
            source=card,
        )
        return charge.id

# Step 4: Replace all call sites with abstraction
class OrderService:
    def __init__(self, payment_processor: PaymentProcessor):
        self.payment = payment_processor

    async def checkout(self, cart, card):
        # Now works with either implementation
        tx_id = await self.payment.process_payment(cart.total, card)
        return await self.create_order(cart, tx_id)

# Step 5: Switch implementation via dependency injection
def get_payment_processor() -> PaymentProcessor:
    if feature_flags.is_enabled("stripe_payments"):
        return StripePaymentProcessor(stripe_client)
    return LegacyPaymentProcessor()
```

## Extract Service Pattern

```python
# Before: Monolithic order processing
class OrderController:
    def create_order(self, user_id, items):
        # Validation
        if not items:
            raise ValueError("Empty order")

        # Calculate total
        total = sum(item.price * item.quantity for item in items)

        # Apply discounts
        discount = self.calculate_discount(user_id, total)
        final_total = total - discount

        # Process payment
        payment_id = self.charge_card(user_id, final_total)

        # Create order
        order = self.db.create_order(user_id, items, final_total)

        # Send notifications
        self.send_email(user_id, order.id)
        self.send_sms(user_id, "Order confirmed")

        # Update inventory
        self.update_inventory(items)

        return order

# After: Extracted services
class OrderService:
    def __init__(
        self,
        pricing: PricingService,
        payment: PaymentService,
        notification: NotificationService,
        inventory: InventoryService,
    ):
        self.pricing = pricing
        self.payment = payment
        self.notification = notification
        self.inventory = inventory

    async def create_order(self, user_id: int, items: list[OrderItem]):
        # Each service has single responsibility
        total = await self.pricing.calculate_total(items, user_id)
        payment_id = await self.payment.process(user_id, total)

        order = await self._save_order(user_id, items, total, payment_id)

        # Background tasks for non-critical operations
        background_tasks.add_task(self.notification.send_order_confirmation, order)
        background_tasks.add_task(self.inventory.update_stock, items)

        return order

# Extracted pricing service
class PricingService:
    async def calculate_total(
        self,
        items: list[OrderItem],
        user_id: int,
    ) -> Decimal:
        subtotal = sum(item.price * item.quantity for item in items)
        discount = await self.get_user_discount(user_id, subtotal)
        return subtotal - discount

    async def get_user_discount(self, user_id: int, subtotal: Decimal) -> Decimal:
        user = await self.user_repo.get(user_id)
        if user.is_premium:
            return subtotal * Decimal("0.1")  # 10% off
        return Decimal("0")
```

## Adapter Pattern for Legacy Integration

```python
# Legacy system with incompatible interface
class LegacyInventorySystem:
    def GetItemCount(self, itemCode: str) -> int:
        """Legacy method with different naming convention"""
        pass

    def DecrementStock(self, itemCode: str, qty: int) -> bool:
        pass

# Modern interface
class InventoryRepository(ABC):
    @abstractmethod
    async def get_stock_level(self, sku: str) -> int:
        pass

    @abstractmethod
    async def reduce_stock(self, sku: str, quantity: int) -> None:
        pass

# Adapter bridges the gap
class LegacyInventoryAdapter(InventoryRepository):
    def __init__(self, legacy_system: LegacyInventorySystem):
        self.legacy = legacy_system

    async def get_stock_level(self, sku: str) -> int:
        # Translate modern call to legacy method
        return await asyncio.to_thread(self.legacy.GetItemCount, sku)

    async def reduce_stock(self, sku: str, quantity: int) -> None:
        success = await asyncio.to_thread(
            self.legacy.DecrementStock, sku, quantity
        )
        if not success:
            raise StockError(f"Failed to reduce stock for {sku}")

# Modern code uses consistent interface
class OrderFulfillment:
    def __init__(self, inventory: InventoryRepository):
        self.inventory = inventory

    async def fulfill_order(self, order):
        for item in order.items:
            stock = await self.inventory.get_stock_level(item.sku)
            if stock >= item.quantity:
                await self.inventory.reduce_stock(item.sku, item.quantity)
```

## Facade Pattern for Simplification

```python
# Complex legacy subsystems
class LegacyAuthSystem:
    def authenticate_user(self, username, password): pass
    def check_permissions(self, user_id, resource): pass
    def get_user_roles(self, user_id): pass

class LegacySessionManager:
    def create_session(self, user_id): pass
    def validate_session(self, session_id): pass

class LegacyAuditLogger:
    def log_login(self, user_id, ip_address): pass

# Facade provides simple interface
class AuthFacade:
    """Simplified authentication interface wrapping legacy systems"""

    def __init__(
        self,
        auth: LegacyAuthSystem,
        sessions: LegacySessionManager,
        audit: LegacyAuditLogger,
    ):
        self.auth = auth
        self.sessions = sessions
        self.audit = audit

    async def login(
        self,
        username: str,
        password: str,
        ip_address: str,
    ) -> str | None:
        """One method instead of coordinating three systems"""
        # Coordinate legacy systems
        user = await asyncio.to_thread(
            self.auth.authenticate_user, username, password
        )
        if not user:
            return None

        session_id = await asyncio.to_thread(
            self.sessions.create_session, user.id
        )

        await asyncio.to_thread(
            self.audit.log_login, user.id, ip_address
        )

        return session_id

    async def check_access(self, session_id: str, resource: str) -> bool:
        """Simplified permission check"""
        session = await asyncio.to_thread(
            self.sessions.validate_session, session_id
        )
        if not session:
            return False

        return await asyncio.to_thread(
            self.auth.check_permissions, session.user_id, resource
        )

# Client code is much simpler
@app.post("/login")
async def login(credentials: LoginRequest):
    session_id = await auth_facade.login(
        credentials.username,
        credentials.password,
        request.client.host,
    )
    if session_id:
        return {"session_id": session_id}
    raise HTTPException(401, "Invalid credentials")
```

## Replace Algorithm Pattern

```python
# Legacy algorithm with poor performance
def legacy_search_products(query: str, products: list) -> list:
    """O(n) linear search through all products"""
    results = []
    for product in products:
        if query.lower() in product.name.lower():
            results.append(product)
        elif query.lower() in product.description.lower():
            results.append(product)
    return results

# Step 1: Extract algorithm to its own class
class ProductSearchStrategy(ABC):
    @abstractmethod
    def search(self, query: str) -> list[Product]:
        pass

class LegacyProductSearch(ProductSearchStrategy):
    def __init__(self, products: list):
        self.products = products

    def search(self, query: str) -> list[Product]:
        return legacy_search_products(query, self.products)

# Step 2: Implement improved algorithm
class ElasticsearchProductSearch(ProductSearchStrategy):
    def __init__(self, es_client):
        self.es = es_client

    async def search(self, query: str) -> list[Product]:
        response = await self.es.search(
            index="products",
            body={
                "query": {
                    "multi_match": {
                        "query": query,
                        "fields": ["name^2", "description"],
                        "fuzziness": "AUTO",
                    }
                }
            },
        )
        return [Product.from_es(hit) for hit in response["hits"]["hits"]]

# Step 3: Use strategy pattern for gradual rollout
class ProductService:
    def __init__(self, search_strategy: ProductSearchStrategy):
        self.search = search_strategy

    async def find_products(self, query: str) -> list[Product]:
        return await self.search.search(query)

# Dependency injection controls which algorithm is used
def get_search_strategy() -> ProductSearchStrategy:
    if feature_flags.is_enabled("elasticsearch_search"):
        return ElasticsearchProductSearch(es_client)
    return LegacyProductSearch(product_cache)
```

## Introduce Repository Pattern

```python
# Legacy data access scattered throughout code
class OrderController:
    def get_order(self, order_id):
        # Direct SQL in controller
        result = db.execute("SELECT * FROM orders WHERE id = ?", order_id)
        return result.fetchone()

# Step 1: Create repository interface
class OrderRepository(ABC):
    @abstractmethod
    async def get_by_id(self, order_id: int) -> Order | None:
        pass

    @abstractmethod
    async def create(self, order: Order) -> Order:
        pass

    @abstractmethod
    async def update(self, order: Order) -> Order:
        pass

# Step 2: Implement for legacy database
class LegacyOrderRepository(OrderRepository):
    def __init__(self, db_connection):
        self.db = db_connection

    async def get_by_id(self, order_id: int) -> Order | None:
        result = await asyncio.to_thread(
            self.db.execute,
            "SELECT * FROM orders WHERE id = ?",
            order_id,
        )
        row = result.fetchone()
        return Order.from_legacy_row(row) if row else None

# Step 3: Implement modern version
class SQLAlchemyOrderRepository(OrderRepository):
    def __init__(self, db: AsyncSession):
        self.db = db

    async def get_by_id(self, order_id: int) -> Order | None:
        return await self.db.get(Order, order_id)

    async def create(self, order: Order) -> Order:
        self.db.add(order)
        await self.db.flush()
        return order

# Controllers now use repository
class OrderController:
    def __init__(self, order_repo: OrderRepository):
        self.orders = order_repo

    async def get_order(self, order_id: int):
        order = await self.orders.get_by_id(order_id)
        if not order:
            raise HTTPException(404)
        return order
```

## Quick Reference

| Pattern | Use When | Benefit |
|---------|----------|---------|
| Branch by Abstraction | Large refactoring needed | Incremental migration |
| Extract Service | Class doing too much | Single responsibility |
| Adapter | Legacy interface incompatible | Bridge old and new |
| Facade | Complex subsystem | Simplified interface |
| Replace Algorithm | Performance/maintainability | Swap implementations |
| Repository | Data access scattered | Centralized data logic |

---

## Source: legacy-modernizer/strangler-fig-pattern.md

# Strangler Fig Pattern

## Pattern Overview

The strangler fig pattern gradually replaces legacy systems by incrementally building new functionality around the old system, eventually "strangling" it out of existence.

```
Legacy System → Facade/Router → New System
     ↓              ↓               ↓
  Old Code    Feature Flags    Modern Code
     ↓              ↓               ↓
  Phase 1:    Route 10%       Validate New
  Phase 2:    Route 50%       Monitor Metrics
  Phase 3:    Route 100%      Remove Legacy
```

## API Gateway Strangler

```python
# Facade layer routing requests to old/new systems
from fastapi import FastAPI, Request
from typing import Literal

app = FastAPI()

MIGRATION_CONFIG = {
    "users.create": {"new_percentage": 100, "module": "new"},
    "users.update": {"new_percentage": 50, "module": "new"},
    "users.list": {"new_percentage": 10, "module": "new"},
    "orders.create": {"new_percentage": 0, "module": "legacy"},
}

@app.post("/api/users")
async def create_user(request: Request):
    feature = "users.create"
    config = MIGRATION_CONFIG.get(feature, {"new_percentage": 0})

    # Feature flag + canary rollout
    use_new = should_use_new_system(request, config["new_percentage"])

    if use_new:
        return await new_user_service.create(request)
    else:
        return await legacy_user_service.create(request)

def should_use_new_system(request: Request, percentage: int) -> bool:
    """Determine routing based on percentage + user attributes"""
    if percentage == 0:
        return False
    if percentage == 100:
        return True

    # Canary: use user_id hash for consistent routing
    user_id = request.headers.get("X-User-Id", "")
    hash_val = hash(user_id) % 100
    return hash_val < percentage
```

## Service Extraction with Adapter

```python
# Legacy monolith code
class LegacyOrderService:
    def create_order(self, user_id: int, items: list) -> dict:
        # Complex legacy logic with database calls
        order = {"id": 123, "user_id": user_id, "items": items}
        self.db.execute("INSERT INTO orders ...")
        return order

# Step 1: Extract interface
from abc import ABC, abstractmethod

class OrderServiceInterface(ABC):
    @abstractmethod
    async def create_order(self, user_id: int, items: list) -> dict:
        pass

# Step 2: Adapter for legacy code
class LegacyOrderAdapter(OrderServiceInterface):
    def __init__(self, legacy_service: LegacyOrderService):
        self.legacy = legacy_service

    async def create_order(self, user_id: int, items: list) -> dict:
        # Wrap synchronous legacy in async
        return await asyncio.to_thread(
            self.legacy.create_order, user_id, items
        )

# Step 3: New implementation
class ModernOrderService(OrderServiceInterface):
    def __init__(self, db: AsyncSession, event_bus: EventBus):
        self.db = db
        self.event_bus = event_bus

    async def create_order(self, user_id: int, items: list) -> dict:
        async with self.db.begin():
            order = Order(user_id=user_id, items=items)
            self.db.add(order)
            await self.db.flush()

            # Emit event for other services
            await self.event_bus.publish(
                "order.created", {"order_id": order.id}
            )
            return order.to_dict()

# Step 4: Feature flag routing
async def get_order_service(
    request: Request,
    db: AsyncSession,
) -> OrderServiceInterface:
    if feature_flags.is_enabled("modern_orders", request):
        return ModernOrderService(db, event_bus)
    else:
        return LegacyOrderAdapter(legacy_order_service)
```

## Database Strangler Pattern

```python
# Dual-write to old and new databases during migration
class DualWriteOrderRepository:
    def __init__(
        self,
        legacy_db: Connection,
        modern_db: AsyncSession,
    ):
        self.legacy_db = legacy_db
        self.modern_db = modern_db

    async def create(self, order_data: dict) -> Order:
        # Write to new system (source of truth)
        async with self.modern_db.begin():
            order = Order(**order_data)
            self.modern_db.add(order)
            await self.modern_db.flush()
            order_id = order.id

        # Background sync to legacy (best effort)
        try:
            await self._sync_to_legacy(order_id, order_data)
        except Exception as e:
            # Log but don't fail - new DB is source of truth
            logger.error(f"Legacy sync failed: {e}")

        return order

    async def get(self, order_id: int) -> Order | None:
        # Read from new system
        result = await self.modern_db.get(Order, order_id)
        if result:
            return result

        # Fallback to legacy if not found (migration in progress)
        legacy_data = await self._read_from_legacy(order_id)
        if legacy_data:
            # Lazy migration: move to new DB
            return await self._migrate_order(legacy_data)

        return None
```

## UI Component Strangler

```typescript
// React: Replace legacy jQuery components incrementally
import { lazy, Suspense } from 'react';

// Feature flag component wrapper
function StranglerComponent({
  feature,
  legacySelector,
  NewComponent,
  ...props
}) {
  const useNew = useFeatureFlag(feature);

  if (useNew) {
    return (
      <Suspense fallback={<Spinner />}>
        <NewComponent {...props} />
      </Suspense>
    );
  }

  // Render legacy jQuery component
  return <LegacyWrapper selector={legacySelector} />;
}

// Usage
const ModernUserTable = lazy(() => import('./UserTable'));

export function UserManagement() {
  return (
    <StranglerComponent
      feature="modern-user-table"
      legacySelector="#legacy-user-table"
      NewComponent={ModernUserTable}
      onUserClick={handleUserClick}
    />
  );
}
```

## Event Interception

```python
# Intercept events from legacy system
from typing import Callable
import functools

def intercept_legacy_event(event_name: str):
    """Decorator to intercept and modernize legacy events"""
    def decorator(handler: Callable):
        @functools.wraps(handler)
        async def wrapper(*args, **kwargs):
            # Transform legacy event to modern format
            modern_event = transform_legacy_event(event_name, args, kwargs)

            # Emit to new event bus
            await event_bus.publish(event_name, modern_event)

            # Still call legacy handler (during transition)
            return await handler(*args, **kwargs)
        return wrapper
    return decorator

# Apply to legacy code
@intercept_legacy_event("user.registered")
async def legacy_user_registration_handler(user_data):
    # Old code continues to work
    send_welcome_email(user_data["email"])

# New services can now subscribe to modernized events
@event_bus.subscribe("user.registered")
async def modern_analytics_handler(event):
    await analytics.track_registration(event["user_id"])
```

## Migration Phases

```python
# Phase tracking and rollback
class MigrationPhase:
    def __init__(self, name: str, percentage: int, metrics: dict):
        self.name = name
        self.percentage = percentage
        self.metrics = metrics

    async def validate(self) -> bool:
        """Check if phase is successful before proceeding"""
        for metric, threshold in self.metrics.items():
            current = await monitoring.get_metric(metric)
            if current > threshold:
                await self.rollback()
                return False
        return True

    async def rollback(self):
        """Instant rollback to previous phase"""
        await feature_flags.set_percentage(self.name, self.percentage - 10)
        await alerts.send(f"Rollback triggered for {self.name}")

# Migration plan
PHASES = [
    MigrationPhase("orders_v2", 0, {}),  # Setup
    MigrationPhase("orders_v2", 10, {"error_rate": 0.01}),  # Canary
    MigrationPhase("orders_v2", 50, {"error_rate": 0.005}),  # Ramp
    MigrationPhase("orders_v2", 100, {"error_rate": 0.001}),  # Full
]
```

## Quick Reference

| Stage | Actions | Validation |
|-------|---------|------------|
| Setup | Create facade, feature flags | Smoke tests pass |
| Canary | Route 10% traffic | Error rate < 1% |
| Ramp | Route 50% traffic | Performance parity |
| Full | Route 100% traffic | All metrics green |
| Cleanup | Remove legacy code | Legacy unused 30 days |

---

## Source: legacy-modernizer/system-assessment.md

# System Assessment

## Codebase Analysis Checklist

```python
# Automated assessment script
from pathlib import Path
import ast
import re
from collections import defaultdict

class LegacyCodeAnalyzer:
    def __init__(self, codebase_path: Path):
        self.path = codebase_path
        self.metrics = defaultdict(int)
        self.issues = []

    def analyze(self):
        """Run comprehensive analysis"""
        self.count_lines_of_code()
        self.analyze_dependencies()
        self.find_code_smells()
        self.check_test_coverage()
        self.identify_hotspots()
        return self.generate_report()

    def count_lines_of_code(self):
        """Basic size metrics"""
        for py_file in self.path.rglob("*.py"):
            with open(py_file) as f:
                lines = f.readlines()
                self.metrics['total_lines'] += len(lines)
                self.metrics['files'] += 1

                # Count code vs comments
                code_lines = [l for l in lines if l.strip() and not l.strip().startswith('#')]
                self.metrics['code_lines'] += len(code_lines)

    def analyze_dependencies(self):
        """Find external and internal dependencies"""
        dependencies = set()

        for py_file in self.path.rglob("*.py"):
            with open(py_file) as f:
                tree = ast.parse(f.read())

            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    for alias in node.names:
                        dependencies.add(alias.name.split('.')[0])
                elif isinstance(node, ast.ImportFrom):
                    if node.module:
                        dependencies.add(node.module.split('.')[0])

        self.metrics['dependencies'] = len(dependencies)
        self.dependencies = dependencies

    def find_code_smells(self):
        """Detect common legacy code issues"""
        for py_file in self.path.rglob("*.py"):
            with open(py_file) as f:
                content = f.read()
                tree = ast.parse(content)

            # Long functions
            for node in ast.walk(tree):
                if isinstance(node, ast.FunctionDef):
                    func_length = node.end_lineno - node.lineno
                    if func_length > 50:
                        self.issues.append({
                            'type': 'long_function',
                            'file': str(py_file),
                            'function': node.name,
                            'lines': func_length,
                        })

            # Global variables
            if re.search(r'^[A-Z_]+ = ', content, re.MULTILINE):
                self.metrics['global_vars'] += len(
                    re.findall(r'^[A-Z_]+ = ', content, re.MULTILINE)
                )

            # SQL in code (sign of tight coupling)
            if re.search(r'(SELECT|INSERT|UPDATE|DELETE)\s+', content, re.IGNORECASE):
                self.metrics['raw_sql'] += 1
                self.issues.append({
                    'type': 'raw_sql',
                    'file': str(py_file),
                })

    def check_test_coverage(self):
        """Calculate test coverage"""
        test_files = list(self.path.rglob("test_*.py"))
        self.metrics['test_files'] = len(test_files)
        self.metrics['test_coverage_estimate'] = (
            len(test_files) / max(self.metrics['files'], 1) * 100
        )

    def identify_hotspots(self):
        """Find files changed most often (requires git)"""
        import subprocess

        try:
            result = subprocess.run(
                ['git', 'log', '--format=format:', '--name-only'],
                cwd=self.path,
                capture_output=True,
                text=True,
            )

            file_changes = defaultdict(int)
            for line in result.stdout.split('\n'):
                if line.strip():
                    file_changes[line.strip()] += 1

            # Top 10 changed files
            self.hotspots = sorted(
                file_changes.items(),
                key=lambda x: x[1],
                reverse=True
            )[:10]
        except Exception:
            self.hotspots = []

    def generate_report(self):
        """Generate assessment report"""
        return {
            'summary': {
                'total_files': self.metrics['files'],
                'total_lines': self.metrics['total_lines'],
                'code_lines': self.metrics['code_lines'],
                'dependencies': self.metrics['dependencies'],
                'test_coverage_estimate': f"{self.metrics['test_coverage_estimate']:.1f}%",
            },
            'issues': {
                'long_functions': len([i for i in self.issues if i['type'] == 'long_function']),
                'raw_sql_usage': self.metrics['raw_sql'],
                'global_variables': self.metrics['global_vars'],
            },
            'hotspots': self.hotspots,
            'detailed_issues': self.issues[:20],  # Top 20 issues
        }

# Usage
analyzer = LegacyCodeAnalyzer(Path('./legacy_app'))
report = analyzer.analyze()
print(json.dumps(report, indent=2))
```

## Dependency Analysis

```python
# Identify circular dependencies and tight coupling
import subprocess
import json
from pathlib import Path
from collections import defaultdict

def analyze_dependencies(project_path: Path):
    """Map internal module dependencies"""
    dependencies = defaultdict(set)

    for py_file in project_path.rglob("*.py"):
        module_name = str(py_file.relative_to(project_path)).replace('/', '.').replace('.py', '')

        with open(py_file) as f:
            tree = ast.parse(f.read())

        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom):
                if node.module and not node.module.startswith('.'):
                    # Internal imports only
                    if node.module.split('.')[0] in ['app', 'lib', 'models']:
                        dependencies[module_name].add(node.module)

    return dependencies

def find_circular_dependencies(dependencies: dict):
    """Detect circular dependencies"""
    circular = []

    def has_path(start, end, visited=None):
        if visited is None:
            visited = set()
        if start == end:
            return True
        if start in visited:
            return False
        visited.add(start)
        for dep in dependencies.get(start, []):
            if has_path(dep, end, visited):
                return True
        return False

    for module, deps in dependencies.items():
        for dep in deps:
            if has_path(dep, module):
                circular.append((module, dep))

    return circular

# Visualize dependency graph
def generate_dependency_graph(dependencies: dict, output_file: str):
    """Generate GraphViz diagram"""
    dot_lines = ["digraph dependencies {"]

    for module, deps in dependencies.items():
        for dep in deps:
            dot_lines.append(f'    "{module}" -> "{dep}";')

    dot_lines.append("}")

    Path(output_file).write_text('\n'.join(dot_lines))
    print(f"Generated {output_file} - render with: dot -Tpng {output_file} -o deps.png")
```

## Technical Debt Calculation

```python
from datetime import datetime, timedelta

class TechnicalDebtCalculator:
    """Calculate technical debt using SQALE method"""

    SEVERITY_MULTIPLIERS = {
        'critical': 1.0,   # 1 day to fix
        'major': 0.5,      # 4 hours
        'minor': 0.25,     # 2 hours
        'info': 0.1,       # 30 min
    }

    def __init__(self):
        self.debt_items = []

    def add_issue(self, issue_type: str, severity: str, count: int = 1):
        """Add technical debt item"""
        days_to_fix = self.SEVERITY_MULTIPLIERS[severity] * count
        self.debt_items.append({
            'type': issue_type,
            'severity': severity,
            'count': count,
            'effort_days': days_to_fix,
        })

    def calculate_total_debt(self):
        """Calculate total remediation effort"""
        total_days = sum(item['effort_days'] for item in self.debt_items)
        return {
            'total_days': round(total_days, 1),
            'total_weeks': round(total_days / 5, 1),
            'estimated_cost': round(total_days * 800, 2),  # $800/day avg
            'breakdown': self.debt_items,
        }

# Usage based on code analysis
debt_calc = TechnicalDebtCalculator()

# From static analysis results
debt_calc.add_issue('long_functions', 'major', count=45)
debt_calc.add_issue('circular_dependencies', 'critical', count=8)
debt_calc.add_issue('missing_tests', 'major', count=120)
debt_calc.add_issue('security_vulnerabilities', 'critical', count=12)
debt_calc.add_issue('deprecated_dependencies', 'major', count=15)
debt_calc.add_issue('code_duplication', 'minor', count=89)

report = debt_calc.calculate_total_debt()
# Output: ~95 days of work, ~19 weeks, ~$76,000
```

## Risk Assessment Matrix

```python
from enum import Enum

class Risk(Enum):
    LOW = 1
    MEDIUM = 2
    HIGH = 3
    CRITICAL = 4

class RiskAssessment:
    def __init__(self):
        self.risks = []

    def assess(self, area: str, impact: Risk, probability: Risk, mitigation: str):
        """Assess risk for modernization area"""
        risk_score = impact.value * probability.value

        self.risks.append({
            'area': area,
            'impact': impact.name,
            'probability': probability.name,
            'score': risk_score,
            'severity': self._get_severity(risk_score),
            'mitigation': mitigation,
        })

    def _get_severity(self, score: int) -> str:
        if score >= 12:
            return 'CRITICAL'
        elif score >= 8:
            return 'HIGH'
        elif score >= 4:
            return 'MEDIUM'
        else:
            return 'LOW'

    def get_prioritized_risks(self):
        """Return risks sorted by severity"""
        return sorted(self.risks, key=lambda r: r['score'], reverse=True)

# Example risk assessment
risks = RiskAssessment()

risks.assess(
    area="Database migration",
    impact=Risk.CRITICAL,
    probability=Risk.MEDIUM,
    mitigation="Implement dual-write pattern with comprehensive monitoring"
)

risks.assess(
    area="Authentication system upgrade",
    impact=Risk.CRITICAL,
    probability=Risk.LOW,
    mitigation="Shadow testing in production, feature flags for rollback"
)

risks.assess(
    area="UI framework migration",
    impact=Risk.MEDIUM,
    probability=Risk.MEDIUM,
    mitigation="Incremental component replacement, A/B testing"
)

risks.assess(
    area="Legacy API deprecation",
    impact=Risk.HIGH,
    probability=Risk.HIGH,
    mitigation="12-month sunset period, client migration support, versioning"
)

for risk in risks.get_prioritized_risks():
    print(f"{risk['severity']}: {risk['area']}")
```

## Modernization Roadmap Template

```python
from dataclasses import dataclass
from datetime import date, timedelta
from typing import List

@dataclass
class MigrationPhase:
    name: str
    description: str
    duration_weeks: int
    dependencies: List[str]
    success_metrics: dict
    rollback_plan: str

class ModernizationRoadmap:
    def __init__(self, start_date: date):
        self.start_date = start_date
        self.phases = []

    def add_phase(self, phase: MigrationPhase):
        self.phases.append(phase)

    def generate_timeline(self):
        """Generate week-by-week timeline"""
        timeline = []
        current_date = self.start_date

        for phase in self.phases:
            end_date = current_date + timedelta(weeks=phase.duration_weeks)
            timeline.append({
                'phase': phase.name,
                'start': current_date.isoformat(),
                'end': end_date.isoformat(),
                'duration_weeks': phase.duration_weeks,
                'dependencies': phase.dependencies,
            })
            current_date = end_date

        return timeline

# Example roadmap
roadmap = ModernizationRoadmap(start_date=date(2024, 1, 1))

roadmap.add_phase(MigrationPhase(
    name="Assessment & Planning",
    description="Code analysis, dependency mapping, risk assessment",
    duration_weeks=2,
    dependencies=[],
    success_metrics={'assessment_complete': True, 'roadmap_approved': True},
    rollback_plan="N/A - planning phase"
))

roadmap.add_phase(MigrationPhase(
    name="Test Coverage",
    description="Build characterization tests for critical paths",
    duration_weeks=4,
    dependencies=["Assessment & Planning"],
    success_metrics={'coverage': '80%', 'characterization_tests': 200},
    rollback_plan="Continue with existing tests"
))

roadmap.add_phase(MigrationPhase(
    name="Database Migration Setup",
    description="Implement dual-write pattern, lazy migration",
    duration_weeks=3,
    dependencies=["Test Coverage"],
    success_metrics={'dual_write_working': True, 'data_consistency': '99.9%'},
    rollback_plan="Disable dual-write, continue legacy DB only"
))

roadmap.add_phase(MigrationPhase(
    name="Service Extraction - Phase 1",
    description="Extract payment service using strangler fig",
    duration_weeks=6,
    dependencies=["Database Migration Setup"],
    success_metrics={'service_deployed': True, 'error_rate': '<0.1%', 'traffic': '100%'},
    rollback_plan="Route 100% traffic back to monolith via feature flag"
))

timeline = roadmap.generate_timeline()
```

## Stakeholder Communication Template

```python
# Weekly status report generator
from datetime import datetime

class ModernizationStatusReport:
    def __init__(self, week_number: int):
        self.week = week_number
        self.completed = []
        self.in_progress = []
        self.blockers = []
        self.metrics = {}

    def generate_report(self) -> str:
        """Generate stakeholder-friendly report"""
        return f"""
# Legacy Modernization - Week {self.week} Status

## Executive Summary
- **Progress**: {self._calculate_progress()}% complete
- **On Track**: {'Yes' if not self.blockers else 'Blocked'}
- **Risk Level**: {self._assess_risk_level()}

## This Week's Accomplishments
{self._format_list(self.completed)}

## In Progress
{self._format_list(self.in_progress)}

## Blockers & Risks
{self._format_list(self.blockers) if self.blockers else '- None'}

## Key Metrics
{self._format_metrics()}

## Next Week's Goals
{self._format_list(self.next_week_goals)}
        """.strip()

    def _format_list(self, items: list) -> str:
        return '\n'.join(f"- {item}" for item in items)

    def _format_metrics(self) -> str:
        return '\n'.join(f"- {k}: {v}" for k, v in self.metrics.items())
```

## Quick Reference

| Assessment Area | Tools | Output |
|----------------|-------|--------|
| Code Quality | pylint, radon, sonarqube | Complexity, issues |
| Dependencies | pipdeptree, pydeps | Graph, circular deps |
| Technical Debt | SonarQube, CodeClimate | Debt hours, cost |
| Test Coverage | coverage.py, pytest-cov | Percentage, gaps |
| Security | bandit, safety | Vulnerabilities |
| Performance | cProfile, py-spy | Bottlenecks |

---
