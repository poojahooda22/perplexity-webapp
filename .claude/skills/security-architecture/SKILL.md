---
name: security-architecture
description: >
  Security audits, secure coding, system design, architecture decisions, and coding standards.
  Use when reviewing security, designing systems, hardening data/asset pipelines, sanitizing
  uploads, configuring CSP/CORS, protecting served content from abuse, or enforcing standards.
metadata:
  pathPatterns: ["*.security*", "auth/**", "middleware*/**", "lib/security/**"]
  bashPattern: ["security|audit|owasp|vulnerability|architecture|design.doc|csp|cors|upload|sanitiz|hotlink|rate.?limit"]
  priority: 90
  promptSignals:
    phrases:
      - 'security audit'
      - 'CSP'
      - 'sanitize upload'
      - 'threat model'
      - 'secure the pipeline'
      - 'harden the app'
      - 'OWASP'
      - 'CDN abuse'
---

# Security & Architecture Chief

> Decision tree routing for security and system design.
> This skill covers general web/application security AND the extra attack surfaces that appear in
> apps with file uploads, a client-side asset/render pipeline, and a public CDN.

---

## Quick Reference: Security Surfaces Beyond a Plain CRUD App

Many apps are NOT a typical authenticated-CRUD app. The extra security surface can include:

1. **Client-side compute/render pipeline** — code or assets compiled/executed on user hardware
2. **Asset export** — rendered output exported as images/video/files (data/IP leakage vector)
3. **File uploads** — user-uploaded media bound into the pipeline (injection vector)
4. **Structured-document serialization** — JSON documents/graphs stored and loaded (deserialization attacks)
5. **Real-time client processing** — multi-pass work running in the browser (resource exhaustion)
6. **Served content as product** — public assets/source that ARE the intellectual property

These are in ADDITION to standard web/framework security concerns.

---

## Decision Tree

```
Security/architecture task received
|
+-- Is this about a client render/compute pipeline, file uploads, or canvas/asset export?
|   |
|   +-- CSP headers for a rich client app?
|   |   => READ references/client-pipeline-security-patterns.md #csp-for-rich-client-applications
|   |
|   +-- User upload (image/SVG/video/file)?
|   |   => READ references/client-pipeline-security-patterns.md #user-upload-sanitization
|   |
|   +-- Untrusted code/expression execution safety?
|   |   => READ references/client-pipeline-security-patterns.md #untrusted-code-execution-prevention
|   |
|   +-- CORS for asset/texture loading?
|   |   => READ references/client-pipeline-security-patterns.md #cors-for-asset-loading
|   |
|   +-- Client context security (fingerprinting, context loss)?
|   |   => READ references/client-pipeline-security-patterns.md #client-context-security
|   |
|   +-- Export security (source/IP, canvas data)?
|       => READ references/client-pipeline-security-patterns.md #export-security
|
+-- Is this about CDN abuse, hotlinking, embed security, or resource enumeration?
|   |
|   +-- Hotlinking / bandwidth theft / origin validation?
|   |   => READ references/cdn-abuse-prevention.md #6-origin-validation--hotlink-protection
|   |
|   +-- Resource ID enumeration / signed URLs?
|   |   => READ references/cdn-abuse-prevention.md #2-resource-enumeration-prevention
|   |
|   +-- XSS in embed / PostMessage spoofing / injection?
|   |   => READ references/cdn-abuse-prevention.md #3-embed-injection-attacks
|   |
|   +-- Compute abuse / resource bombs / memory exhaustion?
|   |   => READ references/cdn-abuse-prevention.md #4-compute-abuse-prevention
|   |
|   +-- Rate limiting architecture?
|   |   => READ references/cdn-abuse-prevention.md #5-rate-limiting-architecture
|   |
|   +-- CDN monitoring / anomaly detection?
|       => READ references/cdn-abuse-prevention.md #7-monitoring--detection
|
+-- Is this a general security review or audit?
|   => READ references/01-security-review.md
|
+-- Is this full-stack security (auth, API, DB)?
|   => READ references/02-fullstack-security.md
|
+-- Is this system design or architecture?
|   => READ references/03-system-design.md
|
+-- Is this legacy modernization?
|   => READ references/04-modernization.md
|
+-- Is this coding standards enforcement?
|   => READ references/05-coding-standards.md
|
+-- Multiple concerns?
    => READ this file non-negotiables, then the relevant references above
```

---

## Non-Negotiables (Every PR, Every Deploy)

These are absolute requirements. Violations block merge.

### 1. No Hardcoded Secrets

- ZERO API keys, tokens, passwords, or connection strings in source code
- All secrets via environment variables or the platform's environment config
- `.env.local` is gitignored; `.env.example` contains only key names, never values
- No source file (including asset/template files) may contain API endpoints or tokens
- Pre-commit hook scans for secret patterns (see the project's production-engineering skill)

### 2. Content Security Policy

- CSP headers configured in the app config or middleware
- `script-src: 'self'` — inline non-script payloads (e.g. data passed to an API, not executed as JS) are NOT scripts
- `style-src: 'self' 'unsafe-inline'` — required for utility-CSS / CSS-in-JS frameworks
- `img-src: 'self' data: blob:` — required for base64/inline media and canvas export
- `connect-src: 'self' <your-api-and-asset-origins>` — API calls and asset loading
- `worker-src: 'self' blob:` — for Web Workers if used
- NEVER use `'unsafe-eval'` unless a hard dependency requires it (most apps do not)
- See `references/client-pipeline-security-patterns.md` for the full CSP template

### 3. Sanitized Uploads

- Validate magic bytes (file signature), not just MIME type or extension
- SVG uploads are CRITICAL RISK — SVG can embed JavaScript, must sanitize or rasterize
- Strip EXIF metadata from images (privacy: GPS coordinates, device info)
- Enforce dimension limits (prevent decode/resource bombs: e.g. max 4096x4096)
- File type allowlist: PNG, JPG, WebP, MP4, WebM ONLY (extend per actual need)
- Server-side re-encoding: convert to safe format before storing
- See `references/client-pipeline-security-patterns.md` for implementation details

### 4. CORS for Asset Loading

- Cross-origin assets bound into a client pipeline require proper CORS or the load fails silently
- Always set `crossOrigin` on elements whose pixels you read back (canvas tainting otherwise)
- CDN buckets must have `Access-Control-Allow-Origin` configured
- Proxy pattern for third-party assets: serve through your own API to add headers
- See `references/client-pipeline-security-patterns.md` for CORS configuration

### 5. Structured-Document Serialization Safety

- Validate all deserialized documents/graphs against a strict JSON schema
- Reject unknown types, unknown property keys, and out-of-range values
- Never use `eval()`, `new Function()`, or dynamic code execution on document data
- Sanitize string properties (labels, custom text) against XSS
- Limit document size: max items, max connections, max depth to prevent DoS

### 6. Served-Content / IP Protection

- Exported output may contain source/assets that ARE the product intellectual property
- Minify/obfuscate identifiers in exported source where IP matters
- Include a license header in exported files
- Never include user credentials, API keys, or auth tokens in exported content
- Rate-limit export endpoints to prevent bulk scraping

---

## Reference Index

### Pipeline-Specific (uploads, client render/compute, export, public CDN)

| Reference                                          | Purpose                                                                                              |
|----------------------------------------------------|------------------------------------------------------------------------------------------------------|
| `references/client-pipeline-security-patterns.md`  | CSP, uploads, untrusted-code safety, CORS, client-context security, export protection               |
| `references/cdn-abuse-prevention.md`               | CDN hotlinking, resource enumeration, embed injection, compute abuse, rate limiting, origin validation |

### General Security
| Reference | Purpose |
|-----------|---------|
| `references/01-security-review.md` | Security review methodology, SAST, vulnerability scanning |
| `references/02-fullstack-security.md` | Auth, API security, DB security, full-stack hardening |
| `references/03-system-design.md` | Architecture patterns, system design principles |
| `references/04-modernization.md` | Legacy system modernization, migration security |
| `references/05-coding-standards.md` | Coding standards, style enforcement, quality gates |

---

## Cross-Skill Integration

### With production-engineering
- Pre-commit hooks for secret scanning
- Build pipeline security (no secrets in build output)
- Deployment security headers
- Environment variable validation at startup
- Rate limiting and DDoS protection

### With the backend/framework skill
- API route authentication and authorization
- Server-side input validation
- Middleware-based CSP header injection
- Image/asset optimization pipeline security
- Route handler CORS configuration

### With a compiler/interpreter skill (if the app executes generated code)
- Source protection in compiled output
- Validation before compilation
- Safe parameter binding (no arbitrary memory/resource access)
- Resource limits in compiled programs

### With an editor/document-architecture skill
- Document/graph serialization and deserialization validation
- Property-panel input sanitization
- Drag-and-drop file upload security
- Real-time preview resource limits (prevent client hang)

---

## Threat Model Summary

| Threat | Vector | Severity | Mitigation |
|--------|--------|----------|------------|
| XSS via SVG upload | User uploads SVG with script tag | CRITICAL | Rasterize SVGs, never render raw |
| Source/IP theft | Export exposes proprietary source/assets | HIGH | Minify/obfuscate exported source |
| Decode/resource bomb | Oversized media crashes the decoder/GPU | HIGH | Enforce max dimensions, validate before binding |
| CORS bypass | External asset loads fail silently | MEDIUM | Proxy pattern, proper CORS headers |
| Document injection | Malicious JSON in saved projects | HIGH | Schema validation, reject unknown types |
| Resource exhaustion | Infinite loop or too many passes | MEDIUM | Timeout watchdog, max pass/iteration count |
| Canvas fingerprinting | toDataURL() used for tracking | LOW | Rate limit, CSP frame-ancestors |
| Context loss data loss | Other tabs trigger client context loss | MEDIUM | Never store user data solely in client/GPU memory |
| Secret leakage in build | API keys in client bundle | CRITICAL | Public-env-prefix audit, env validation |
| EXIF data exposure | Uploaded images contain GPS/device info | MEDIUM | Strip all metadata server-side |

---

## Security Review Checklist (Use Before Every Merge)

```
[ ] No hardcoded secrets (API keys, tokens, passwords)
[ ] CSP headers configured and tested
[ ] All user uploads validated (magic bytes, dimensions, sanitized)
[ ] SVG uploads rasterized or sanitized (no raw SVG rendering)
[ ] CORS configured for all external asset sources
[ ] Document/graph deserialization validates against schema
[ ] No eval() or new Function() on untrusted data anywhere in codebase
[ ] Exported content contains no user secrets
[ ] Proprietary source minified in exports
[ ] Environment variables validated at startup
[ ] API routes have authentication checks
[ ] Rate limiting on export and upload endpoints
[ ] Error messages do not leak internal paths or stack traces
[ ] Dependencies audited (npm audit, no critical vulnerabilities)
[ ] HTTPS enforced in production
```

---

## Emergency Response

If a security vulnerability is discovered in production:

1. **STOP** — do not deploy further changes
2. Assess severity using the threat model above
3. For CRITICAL: hotfix branch, fix, deploy within 4 hours
4. For HIGH: fix within 24 hours
5. Rotate any potentially exposed secrets immediately
6. Audit logs for evidence of exploitation
7. Post-mortem document in `docs/security/` with root cause and prevention
