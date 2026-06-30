# Security Review & Auditing
---

## Source: security-reviewer/SKILL.md

---
name: security-reviewer
description: Identifies security vulnerabilities, generates structured audit reports with severity ratings, and provides actionable remediation guidance. Use when conducting security audits, reviewing code for vulnerabilities, or analyzing infrastructure security. Invoke for SAST scans, penetration testing, DevSecOps practices, cloud security reviews, dependency audits, secrets scanning, or compliance checks. Produces vulnerability reports, prioritized recommendations, and compliance checklists.
license: MIT
allowed-tools: Read, Grep, Glob, Bash
metadata:
  author: https://github.com/Jeffallan
  version: "1.1.0"
  domain: security
  triggers: security review, vulnerability scan, SAST, security audit, penetration test, code audit, security analysis, infrastructure security, DevSecOps, cloud security, compliance audit
  role: specialist
  scope: review
  output-format: report
  related-skills: secure-code-guardian, code-reviewer, devops-engineer, cloud-architect, kubernetes-specialist
---

# Security Reviewer

Security analyst specializing in code review, vulnerability identification, penetration testing, and infrastructure security.

## When to Use This Skill

- Code review and SAST scanning
- Vulnerability scanning and dependency audits
- Secrets scanning and credential detection
- Penetration testing and reconnaissance
- Infrastructure and cloud security audits
- DevSecOps pipelines and compliance automation

## Core Workflow

1. **Scope** — Map attack surface and critical paths. Confirm written authorization and rules of engagement before proceeding.
2. **Scan** — Run SAST, dependency, and secrets tools. Example commands:
   - `semgrep --config=auto .`
   - `bandit -r ./src`
   - `gitleaks detect --source=.`
   - `npm audit --audit-level=moderate`
   - `trivy fs .`
3. **Review** — Manual review of auth, input handling, and crypto. Tools miss context — manual review is mandatory.
4. **Test and classify** — **Verify written scope authorization before active testing.** Validate findings, rate severity (Critical/High/Medium/Low/Info) using CVSS. Confirm exploitability with proof-of-concept only; do not exceed it.
5. **Report** — Confirm findings with stakeholder before finalizing. Document with location, impact, and remediation. Report critical findings immediately.

## Reference Guide

Load detailed guidance based on context:

| Topic | Reference | Load When |
|-------|-----------|-----------|
| SAST Tools | `references/sast-tools.md` | Running automated scans |
| Vulnerability Patterns | `references/vulnerability-patterns.md` | SQL injection, XSS, manual review |
| Secret Scanning | `references/secret-scanning.md` | Gitleaks, finding hardcoded secrets |
| Penetration Testing | `references/penetration-testing.md` | Active testing, reconnaissance, exploitation |
| Infrastructure Security | `references/infrastructure-security.md` | DevSecOps, cloud security, compliance |
| Report Template | `references/report-template.md` | Writing security report |

## Constraints

### MUST DO
- Check authentication/authorization first
- Run automated tools before manual review
- Provide specific file/line locations
- Include remediation for each finding
- Rate severity consistently
- Check for secrets in code
- Verify scope and authorization before active testing
- Document all testing activities
- Follow rules of engagement
- Report critical findings immediately

### MUST NOT DO
- Skip manual review (tools miss things)
- Test on production systems without authorization
- Ignore "low" severity issues
- Assume frameworks handle everything
- Share detailed exploits publicly
- Exploit beyond proof of concept
- Cause service disruption or data loss
- Test outside defined scope

## Output Templates

1. Executive summary with risk assessment
2. Findings table with severity counts
3. Detailed findings with location, impact, and remediation
4. Prioritized recommendations

### Example Finding Entry

```
ID: FIND-001
Severity: High (CVSS 8.1)
Title: SQL Injection in user search endpoint
File: src/api/users.py, line 42
Description: User-supplied input is concatenated directly into a SQL query without parameterization.
Impact: An attacker can read, modify, or delete database contents.
Remediation: Use parameterized queries or an ORM. Replace `cursor.execute(f"SELECT * FROM users WHERE name='{name}'")`
             with `cursor.execute("SELECT * FROM users WHERE name=%s", (name,))`.
References: CWE-89, OWASP A03:2021
```

## Knowledge Reference

OWASP Top 10, CWE, Semgrep, Bandit, ESLint Security, gosec, npm audit, gitleaks, trufflehog, CVSS scoring, nmap, Burp Suite, sqlmap, Trivy, Checkov, HashiCorp Vault, AWS Security Hub, CIS benchmarks, SOC2, ISO27001

---

## Source: security-reviewer/infrastructure-security.md

# Infrastructure Security

## DevSecOps Integration

### CI/CD Security Pipeline

```yaml
# GitHub Actions - Security scanning
name: Security Pipeline
on: [push, pull_request]
jobs:
  security:
    runs-on: ubuntu-latest
    steps:
      - uses: returntocorp/semgrep-action@v1
      - uses: gitleaks/gitleaks-action@v2
      - uses: aquasecurity/trivy-action@master
        with:
          scan-type: 'fs'
          severity: 'CRITICAL,HIGH'
```

### Infrastructure as Code Security

```bash
# Terraform/CloudFormation scanning
checkov -d terraform/ --framework terraform
tfsec terraform/
terrascan scan -d terraform/

# Kubernetes manifest scanning
kubesec scan deployment.yaml
```

## Cloud Security Controls

### AWS Security Hardening

```bash
# Enable security services
aws guardduty create-detector --enable
aws securityhub enable-security-hub
aws cloudtrail create-trail --name security-trail --s3-bucket-name logs

# Check S3 bucket security
aws s3api list-buckets --query "Buckets[].Name" | \
  xargs -I {} aws s3api get-bucket-acl --bucket {}

# IAM password policy
aws iam update-account-password-policy \
  --minimum-password-length 14 \
  --require-symbols --require-numbers \
  --require-uppercase-characters --require-lowercase-characters
```

### Azure Security

```bash
# Enable Security Center
az security auto-provisioning-setting update --name default --auto-provision on

# Enable disk encryption
az vm encryption enable --resource-group myRG --name myVM --disk-encryption-keyvault myKV
```

### GCP Security

```bash
# Enable Security Command Center
gcloud services enable securitycenter.googleapis.com

# Enable VPC Flow Logs
gcloud compute networks subnets update SUBNET --enable-flow-logs
```

## Container Security

### Secure Dockerfile

```dockerfile
FROM node:18-alpine
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001
WORKDIR /app
COPY --chown=nodejs:nodejs package*.json ./
RUN npm ci --only=production
USER nodejs
EXPOSE 3000
HEALTHCHECK --interval=30s CMD node healthcheck.js
CMD ["node", "server.js"]
```

### Kubernetes Security

```yaml
# Pod Security Standards
apiVersion: v1
kind: Pod
metadata:
  name: secure-pod
spec:
  securityContext:
    runAsNonRoot: true
    runAsUser: 1000
    fsGroup: 2000
    seccompProfile:
      type: RuntimeDefault
  containers:
  - name: app
    image: myapp:1.0
    securityContext:
      allowPrivilegeEscalation: false
      readOnlyRootFilesystem: true
      capabilities:
        drop: [ALL]
    resources:
      limits:
        memory: "128Mi"
        cpu: "500m"
---
# Network Policy - Default deny
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-all
spec:
  podSelector: {}
  policyTypes:
  - Ingress
  - Egress
```

## Compliance Automation

### CIS Benchmark Scanning

```bash
# Docker CIS benchmark
docker run --net host --pid host --cap-add audit_control \
  -v /var/lib:/var/lib -v /var/run/docker.sock:/var/run/docker.sock \
  docker/docker-bench-security

# Kubernetes CIS benchmark
kube-bench run --targets master,node

# Linux system hardening
lynis audit system --quick
```

### Compliance as Code (InSpec)

```ruby
# controls/baseline.rb
control 'ssh-hardening' do
  impact 1.0
  title 'SSH Security Configuration'

  describe sshd_config do
    its('Protocol') { should eq '2' }
    its('PermitRootLogin') { should eq 'no' }
    its('PasswordAuthentication') { should eq 'no' }
  end
end

control 'encryption-at-rest' do
  impact 1.0
  title 'S3 Encryption Enabled'

  describe aws_s3_bucket('my-bucket') do
    it { should have_default_encryption_enabled }
  end
end
```

## Secrets Management

### HashiCorp Vault

```bash
# Initialize and configure
vault operator init
vault secrets enable -path=secret kv-v2

# Store secrets
vault kv put secret/app/config api_key="secret123"

# Dynamic database credentials
vault secrets enable database
vault write database/config/postgresql \
  plugin_name=postgresql-database-plugin \
  allowed_roles="app" \
  connection_url="postgresql://{{username}}:{{password}}@localhost:5432/" \
  username="vault" password="vaultpass"

vault write database/roles/app \
  db_name=postgresql \
  creation_statements="CREATE ROLE \"{{name}}\" WITH LOGIN PASSWORD '{{password}}';" \
  default_ttl="1h" max_ttl="24h"
```

### Kubernetes Secrets with External Secrets Operator

```yaml
apiVersion: external-secrets.io/v1beta1
kind: SecretStore
metadata:
  name: vault-backend
spec:
  provider:
    vault:
      server: "https://vault.example.com"
      path: "secret"
      auth:
        kubernetes:
          role: "app-role"
---
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: app-secrets
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: vault-backend
  target:
    name: app-secrets
  data:
  - secretKey: api_key
    remoteRef:
      key: secret/app/config
      property: api_key
```

## Security Monitoring

### SIEM Log Shipping (Filebeat)

```yaml
filebeat.inputs:
- type: log
  paths:
    - /var/log/auth.log
    - /var/log/nginx/*.log
  fields:
    environment: production

output.elasticsearch:
  hosts: ["elasticsearch:9200"]
  index: "security-logs-%{+yyyy.MM.dd}"
```

## Quick Reference

| Area | Tool | Purpose |
|------|------|---------|
| Cloud Security | Prowler, ScoutSuite | AWS/Azure/GCP audit |
| Container | Trivy, Clair | Image scanning |
| IaC | Checkov, tfsec | Terraform/CloudFormation |
| Secrets | Vault, Sealed Secrets | Secret management |
| Compliance | InSpec, OpenSCAP | CIS benchmarks |
| Monitoring | ELK, Splunk | SIEM |

| Framework | Focus | Key Controls |
|-----------|-------|--------------|
| SOC 2 | Security controls | Access, encryption, monitoring |
| ISO 27001 | ISMS | Policy, risk, audit |
| PCI DSS | Payment security | Network segmentation, encryption |
| HIPAA | Healthcare | Encryption, access logs |
| GDPR | Data privacy | Consent, retention, DLP |

---

## Source: security-reviewer/penetration-testing.md

# Penetration Testing

## Reconnaissance

### Passive Information Gathering

```bash
# DNS enumeration
dig example.com ANY
nslookup -type=any example.com

# Subdomain discovery
subfinder -d example.com
amass enum -d example.com

# Certificate transparency
curl -s "https://crt.sh/?q=%.example.com&output=json"
```

### Active Scanning

```bash
# Port scanning
nmap -sV -p- target.com
nmap -sC -sV -oA scan target.com

# Web technology detection
whatweb target.com
```

## Web Application Testing

### Authentication & Authorization

```bash
# Session analysis - Check for:
# - Session timeout, Secure/HttpOnly flags
# - Session fixation, concurrent sessions

# IDOR testing
GET /api/users/123  # Your ID
GET /api/users/124  # Another user - should fail

# Privilege escalation
GET /api/admin/users  # As standard user
```

### Input Validation

```bash
# SQL injection
sqlmap -u "http://target.com/search?q=test" --batch

# XSS payloads
<script>alert(document.domain)</script>
<img src=x onerror=alert(1)>
<svg onload=alert(1)>

# Command injection
; ls -la
| whoami
$(whoami)

# XXE
<?xml version="1.0"?>
<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
<root>&xxe;</root>
```

## API Security Testing

### JWT & Token Security

```bash
# Decode JWT
echo "eyJ..." | base64 -d

# Test none algorithm
# Modify header: {"alg": "none"}

# Weak secret brute force
hashcat -m 16500 jwt.txt wordlist.txt
```

### Rate Limiting & Data Exposure

```bash
# Test rate limits
for i in {1..1000}; do
  curl https://api.target.com/login -d "user=test&pass=test"
done

# Check for excessive data exposure
GET /api/users/me
# Look for: password hashes, internal IDs, sensitive PII

# Mass assignment
POST /api/users/profile
{"email": "new@email.com", "isAdmin": true}
```

## Network Penetration

### Privilege Escalation (Linux)

```bash
# SUID binaries
find / -perm -4000 -type f 2>/dev/null

# Sudo permissions
sudo -l

# Writable paths in PATH
echo $PATH | tr ':' '\n' | xargs -I {} ls -ld {}

# Kernel exploits
uname -a
searchsploit linux kernel $(uname -r)
```

### Lateral Movement

```bash
# Network enumeration
arp -a
netstat -ant

# Service discovery
nmap -sV 192.168.1.0/24

# Credential harvesting
grep -r "password" /home/*/
cat ~/.bash_history | grep -i "pass\|pwd\|secret"
```

## Mobile Application Testing

### Android

```bash
# Decompile APK
apktool d app.apk
jadx -d output app.apk

# Check for secrets
grep -r "api_key\|secret\|password" .

# Insecure storage
adb shell
run-as com.app.package
find . -type f -exec cat {} \;
```

### iOS

```bash
# Class dump
class-dump App.app

# Check data storage
sqlite3 /var/mobile/Applications/.../Library/Caches/data.db
```

## Cloud Security Testing

### AWS

```bash
# S3 bucket enumeration
aws s3 ls s3://bucket-name --no-sign-request
aws s3api get-bucket-acl --bucket bucket-name

# IAM enumeration
aws iam get-user
aws iam list-attached-user-policies --user-name username
```

### Container & Kubernetes

```bash
# Docker escape testing
docker inspect container_id | grep -i privileged
docker inspect container_id | grep -A 5 Mounts

# Kubernetes
kubectl get pods --all-namespaces
kubectl get secrets --all-namespaces
kubectl auth can-i --list
```

## Exploitation Validation

### Proof of Concept Guidelines

```python
# Always demonstrate impact SAFELY

# SQL injection PoC
# DON'T: Extract actual data
# DO: Prove injection with sleep
payload = "' OR SLEEP(5)--"

# DON'T: Delete/modify production data
# DO: Show you COULD with SELECT
payload = "' UNION SELECT 'proof_of_concept'--"
```

### Rules of Engagement

1. **Scope verification** - Only test authorized targets
2. **Time windows** - Respect testing hours
3. **DoS prevention** - Avoid resource exhaustion
4. **Data handling** - Don't exfiltrate real data
5. **Stop on discovery** - Don't exploit beyond proof
6. **Immediate reporting** - Report critical findings ASAP
7. **Documentation** - Record all actions
8. **Cleanup** - Remove test artifacts

## Vulnerability Classification

### Severity Scoring

| Severity | Exploitability | Impact | CVSS Range |
|----------|---------------|---------|------------|
| Critical | Easy | Full compromise | 9.0-10.0 |
| High | Medium | Significant access | 7.0-8.9 |
| Medium | Hard | Limited access | 4.0-6.9 |
| Low | Very hard | Minimal impact | 0.1-3.9 |

### Impact Assessment

- **Critical**: Remote code execution, full data access, admin takeover
- **High**: Authentication bypass, privilege escalation, sensitive data exposure
- **Medium**: CSRF, XSS (non-admin), information disclosure
- **Low**: Missing security headers, verbose errors, rate limiting issues

## Testing Checklist

### OWASP Top 10 Coverage

- [ ] Broken Access Control (IDOR, path traversal)
- [ ] Cryptographic Failures (weak encryption, plaintext)
- [ ] Injection (SQL, XSS, command)
- [ ] Insecure Design (missing auth flows)
- [ ] Security Misconfiguration (defaults, debug mode)
- [ ] Vulnerable Components (outdated dependencies)
- [ ] Authentication Failures (weak passwords, session issues)
- [ ] Data Integrity (deserialization, lack of verification)
- [ ] Logging Failures (missing logs, exposed sensitive data)
- [ ] SSRF (unvalidated URLs)

## Quick Reference

| Test Type | Tools | Focus |
|-----------|-------|-------|
| Web App | Burp Suite, OWASP ZAP | OWASP Top 10 |
| API | Postman, curl | AuthN/AuthZ, data exposure |
| Network | nmap, Metasploit | Services, exploits |
| Mobile | MobSF, Frida | Data storage, crypto |
| Cloud | ScoutSuite, Prowler | Misconfigurations |

| Finding Type | Validation Method | Evidence Required |
|--------------|------------------|-------------------|
| SQL Injection | Sleep-based, error-based | Request/response, timing |
| XSS | Alert box, DOM manipulation | Screenshot, payload |
| IDOR | Access other user's resource | Two user accounts, IDs |
| Auth Bypass | Unauthorized access | Before/after screenshots |
| RCE | Command output (safe) | Whoami, id command output |

---

## Source: security-reviewer/report-template.md

# Security Report Template

## Full Report Template

```markdown
# Security Review Report

## Executive Summary

| Field | Value |
|-------|-------|
| **Application** | [Application Name] |
| **Review Date** | [YYYY-MM-DD] |
| **Reviewer** | [Name] |
| **Scope** | [Files/modules reviewed] |
| **Overall Risk Level** | [Critical/High/Medium/Low] |

### Key Findings
- X Critical vulnerabilities requiring immediate attention
- Y High-severity issues to address before deployment
- Z Medium/Low issues for future consideration

## Findings Summary

| Severity | Count | Status |
|----------|-------|--------|
| Critical | X | Requires immediate fix |
| High | X | Fix before deployment |
| Medium | X | Fix in next sprint |
| Low | X | Backlog |

## Detailed Findings

### [CRITICAL] SQL Injection in User Search

| Field | Value |
|-------|-------|
| **ID** | SEC-001 |
| **Location** | `src/api/users.ts:45` |
| **CWE** | CWE-89 |
| **CVSS** | 9.8 (Critical) |

**Description**
User input directly concatenated into SQL query without sanitization.

**Vulnerable Code**
```typescript
const query = `SELECT * FROM users WHERE name LIKE '%${searchTerm}%'`;
```

**Proof of Concept**
```
GET /api/users?search=' OR '1'='1
```

**Impact**
- Full database access
- Data exfiltration
- Data modification/deletion
- Potential RCE via SQL features

**Remediation**
Use parameterized queries:
```typescript
const query = 'SELECT * FROM users WHERE name LIKE $1';
db.query(query, [`%${searchTerm}%`]);
```

**Effort**: 1 hour
**Priority**: Immediate

---

### [HIGH] Weak Password Requirements

| Field | Value |
|-------|-------|
| **ID** | SEC-002 |
| **Location** | `src/auth/validation.ts:12` |
| **CWE** | CWE-521 |
| **CVSS** | 7.5 (High) |

**Description**
Password policy requires only 6 characters with no complexity requirements.

**Current Policy**
```typescript
const isValid = password.length >= 6;
```

**Impact**
- Susceptible to brute force attacks
- Dictionary attack vulnerability

**Remediation**
Implement stronger requirements:
```typescript
const isValid =
  password.length >= 12 &&
  /[A-Z]/.test(password) &&
  /[a-z]/.test(password) &&
  /[0-9]/.test(password) &&
  /[^A-Za-z0-9]/.test(password);
```

**Effort**: 30 minutes
**Priority**: Before deployment

## Automated Scan Results

### Dependency Vulnerabilities
| Package | Severity | CVE | Fix |
|---------|----------|-----|-----|
| lodash | High | CVE-2021-xxxx | Upgrade to 4.17.21 |

### SAST Findings
| Tool | Critical | High | Medium | Low |
|------|----------|------|--------|-----|
| Semgrep | 1 | 3 | 5 | 8 |
| npm audit | 0 | 2 | 4 | 10 |

## Recommendations

### Immediate (This Sprint)
1. Fix SQL injection vulnerability (SEC-001)
2. Implement parameterized queries globally
3. Update vulnerable dependencies

### Short-term (Next Sprint)
1. Strengthen password policy (SEC-002)
2. Add input validation middleware
3. Enable security headers

### Long-term
1. Implement SAST in CI/CD pipeline
2. Schedule regular security reviews
3. Security training for developers

## Appendix

### Tools Used
- Semgrep v1.x
- npm audit
- Gitleaks v8.x
- Manual code review

### References
- OWASP Top 10 2021
- CWE Database
- CVSS Calculator
```

## Severity Definitions

| Severity | CVSS Score | Response Time |
|----------|------------|---------------|
| Critical | 9.0 - 10.0 | Immediate |
| High | 7.0 - 8.9 | 24-48 hours |
| Medium | 4.0 - 6.9 | 1-2 weeks |
| Low | 0.1 - 3.9 | Next release |

## Quick Reference

| Section | Purpose |
|---------|---------|
| Executive Summary | Management overview |
| Findings Summary | Quick count by severity |
| Detailed Findings | Technical details |
| Scan Results | Automated tool output |
| Recommendations | Prioritized action items |

---

## Source: security-reviewer/sast-tools.md

# SAST Tools

## JavaScript/TypeScript

```bash
# Dependency vulnerabilities
npm audit
npm audit --json > npm-audit.json

# ESLint security plugin
npm install eslint-plugin-security --save-dev
npx eslint --ext .js,.ts . --plugin security

# Snyk
npx snyk test
npx snyk code test
```

## Python

```bash
# Bandit - Python SAST
pip install bandit
bandit -r . -f json -o bandit-report.json
bandit -r . -ll  # Only high severity

# Safety - Dependency check
pip install safety
safety check
safety check -r requirements.txt --json > safety-report.json

# Pyup Safety
pip install pyupio-safety
pyupio-safety check
```

## Go

```bash
# GoSec - Go security checker
go install github.com/securego/gosec/v2/cmd/gosec@latest
gosec ./...
gosec -fmt=json -out=gosec-report.json ./...

# Go vulnerability database
go install golang.org/x/vuln/cmd/govulncheck@latest
govulncheck ./...
```

## Multi-Language Tools

```bash
# Semgrep - Universal SAST
pip install semgrep
semgrep --config=auto .
semgrep --config=p/security-audit .
semgrep --config=p/owasp-top-ten .

# Trivy - Comprehensive scanner
brew install trivy
trivy fs .
trivy fs --security-checks vuln,secret,config .

# SonarQube (requires server)
sonar-scanner -Dsonar.projectKey=myproject
```

## CI/CD Integration

### GitHub Actions

```yaml
- name: Run Semgrep
  uses: returntocorp/semgrep-action@v1
  with:
    config: p/security-audit

- name: Run npm audit
  run: npm audit --audit-level=high

- name: Run Trivy
  uses: aquasecurity/trivy-action@master
  with:
    scan-type: 'fs'
    severity: 'CRITICAL,HIGH'
```

### GitLab CI

```yaml
security-scan:
  image: returntocorp/semgrep
  script:
    - semgrep --config=auto --json -o semgrep.json .
  artifacts:
    reports:
      sast: semgrep.json
```

## Quick Reference

| Language | Primary Tool | Dependency Check |
|----------|--------------|------------------|
| JavaScript | ESLint + security | npm audit |
| TypeScript | ESLint + security | npm audit |
| Python | Bandit | Safety |
| Go | GoSec | govulncheck |
| Java | SpotBugs | OWASP Dependency-Check |
| Ruby | Brakeman | bundler-audit |

| Tool | Strengths | Best For |
|------|-----------|----------|
| Semgrep | Multi-language, custom rules | General SAST |
| Trivy | Container + code + secrets | Comprehensive |
| Bandit | Python-specific | Python projects |
| GoSec | Go-specific | Go projects |
| npm audit | Built-in, fast | Node.js deps |

---

## Source: security-reviewer/secret-scanning.md

# Secret Scanning

## Gitleaks

```bash
# Install
brew install gitleaks

# Scan current directory
gitleaks detect --source . --verbose

# Scan with report
gitleaks detect --source . -f json -r gitleaks-report.json

# Scan git history
gitleaks detect --source . --log-opts="--all"

# Use baseline (ignore known)
gitleaks detect --baseline-path .gitleaks-baseline.json
```

## TruffleHog

```bash
# Install
pip install trufflehog

# Scan filesystem
trufflehog filesystem .

# Scan git repo
trufflehog git file://. --since-commit HEAD~100

# Scan with JSON output
trufflehog filesystem . --json > trufflehog-report.json
```

## Manual Grep Patterns

```bash
# Common secret patterns
grep -rn "api_key\|apikey\|api-key" --include="*.{ts,js,py}" .
grep -rn "secret\|password\|passwd" --include="*.{ts,js,py}" .
grep -rn "private_key\|privatekey" --include="*.{ts,js,py}" .
grep -rn "access_token\|accesstoken" --include="*.{ts,js,py}" .

# AWS credentials
grep -rn "AKIA[0-9A-Z]{16}" .
grep -rn "aws_secret_access_key" .

# Base64 encoded (potential secrets)
grep -rn "[A-Za-z0-9+/]{40,}=" .

# JWT tokens
grep -rn "eyJ[A-Za-z0-9_-]*\.eyJ[A-Za-z0-9_-]*\." .
```

## Common Secret Patterns

| Type | Pattern | Example |
|------|---------|---------|
| AWS Access Key | `AKIA[0-9A-Z]{16}` | AKIAIOSFODNN7EXAMPLE |
| AWS Secret Key | 40 char base64 | wJalrXUtnFEMI/K7MDENG... |
| GitHub Token | `ghp_[A-Za-z0-9]{36}` | ghp_xxxxxxxxxxxx |
| Slack Token | `xox[baprs]-` | xoxb-xxx-xxx |
| Stripe Key | `sk_live_[A-Za-z0-9]{24}` | sk_live_xxxx |
| Private Key | `-----BEGIN.*PRIVATE KEY-----` | RSA/EC keys |
| JWT | `eyJ[A-Za-z0-9_-]*\.eyJ` | Encoded tokens |

## Pre-commit Hook

```yaml
# .pre-commit-config.yaml
repos:
  - repo: https://github.com/gitleaks/gitleaks
    rev: v8.18.0
    hooks:
      - id: gitleaks
```

## CI/CD Integration

```yaml
# GitHub Actions
- name: Gitleaks
  uses: gitleaks/gitleaks-action@v2
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

# GitLab CI
secret_detection:
  image: zricethezav/gitleaks
  script:
    - gitleaks detect --source . -f sarif -r gl-secret-detection-report.sarif
  artifacts:
    reports:
      secret_detection: gl-secret-detection-report.sarif
```

## Remediation Steps

1. **Rotate immediately** - Consider secret compromised
2. **Remove from history** - Use git filter-branch or BFG
3. **Add to .gitignore** - Prevent future commits
4. **Use env variables** - Move to environment
5. **Use secret manager** - AWS Secrets Manager, Vault

```bash
# Remove from git history (BFG)
bfg --replace-text passwords.txt repo.git

# Or git filter-branch
git filter-branch --force --index-filter \
  "git rm --cached --ignore-unmatch path/to/secret" \
  --prune-empty --tag-name-filter cat -- --all
```

## Quick Reference

| Tool | Best For | Speed |
|------|----------|-------|
| Gitleaks | Git history | Fast |
| TruffleHog | Deep scanning | Medium |
| grep | Quick checks | Fast |
| GitHub Secret Scanning | GitHub repos | Auto |

---

## Source: security-reviewer/vulnerability-patterns.md

# Vulnerability Patterns

## SQL Injection

```typescript
// VULNERABLE
const query = `SELECT * FROM users WHERE id = ${userId}`;
const query = `SELECT * FROM users WHERE name = '${name}'`;

// SECURE - Parameterized queries
const query = 'SELECT * FROM users WHERE id = $1';
db.query(query, [userId]);

// SECURE - ORM
const user = await User.findOne({ where: { id: userId } });
```

## XSS (Cross-Site Scripting)

```typescript
// VULNERABLE - Direct HTML injection
element.innerHTML = userInput;
document.write(userInput);

// SECURE - Text content
element.textContent = userInput;

// SECURE - Sanitization
import DOMPurify from 'dompurify';
element.innerHTML = DOMPurify.sanitize(userInput);

// SECURE - React (auto-escaped)
return <div>{userInput}</div>;

// VULNERABLE - React dangerouslySetInnerHTML
return <div dangerouslySetInnerHTML={{ __html: userInput }} />;
```

## Path Traversal

```typescript
// VULNERABLE
const file = path.join(uploadDir, req.query.filename);
res.sendFile(file);

// SECURE - Validate and normalize
const filename = path.basename(req.query.filename);
const file = path.resolve(uploadDir, filename);

if (!file.startsWith(path.resolve(uploadDir))) {
  throw new Error('Invalid path');
}
res.sendFile(file);
```

## Command Injection

```typescript
// VULNERABLE
exec(`ls ${userInput}`);
exec('git clone ' + repoUrl);

// SECURE - Use arrays, avoid shell
execFile('ls', [userInput]);
spawn('git', ['clone', repoUrl]);

// SECURE - Validation
const allowedCommands = ['status', 'log'];
if (!allowedCommands.includes(cmd)) throw new Error('Invalid');
```

## IDOR (Insecure Direct Object Reference)

```typescript
// VULNERABLE - No authorization check
app.get('/documents/:id', async (req, res) => {
  const doc = await Document.findById(req.params.id);
  res.json(doc);
});

// SECURE - Verify ownership
app.get('/documents/:id', async (req, res) => {
  const doc = await Document.findOne({
    _id: req.params.id,
    userId: req.user.id  // Ensure user owns document
  });
  if (!doc) return res.status(404).json({ error: 'Not found' });
  res.json(doc);
});
```

## Insecure Deserialization

```typescript
// VULNERABLE - Python pickle
import pickle
data = pickle.loads(user_input)

// SECURE - Use JSON
import json
data = json.loads(user_input)

// VULNERABLE - Node.js
const obj = eval('(' + userInput + ')');

// SECURE
const obj = JSON.parse(userInput);
```

## Sensitive Data Exposure

```typescript
// VULNERABLE - Logging sensitive data
logger.info('User login', { email, password });
console.log('Token:', authToken);

// SECURE - Redact sensitive fields
logger.info('User login', { email, password: '[REDACTED]' });

// VULNERABLE - Error response exposes internals
res.status(500).json({ error: err.stack });

// SECURE - Generic error
res.status(500).json({ error: 'Internal server error' });
```

## Quick Reference

| Vulnerability | Input Vector | Prevention |
|---------------|--------------|------------|
| SQL Injection | Query params | Parameterized queries |
| XSS | User content | Output encoding |
| Path Traversal | File paths | path.basename + validation |
| Command Injection | Shell args | execFile, no shell |
| IDOR | Resource IDs | Authorization checks |
| Deserialization | Serialized data | JSON only |
| Data Exposure | Logs, errors | Redaction, generic errors |

## OWASP Top 10 Mapping

| OWASP | Vulnerabilities |
|-------|-----------------|
| A01 Broken Access Control | IDOR, path traversal |
| A02 Cryptographic Failures | Weak encryption, plaintext |
| A03 Injection | SQL, XSS, command |
| A04 Insecure Design | Missing auth, IDOR |
| A05 Security Misconfiguration | Debug mode, default creds |
| A06 Vulnerable Components | Outdated dependencies |
| A07 Auth Failures | Weak passwords, session issues |
| A08 Data Integrity | Insecure deserialization |
| A09 Logging Failures | Missing logs, exposed data |
| A10 SSRF | Unvalidated URLs |

---

## Source: secure-code-guardian/SKILL.md

---
name: secure-code-guardian
description: Use when implementing authentication/authorization, securing user input, or preventing OWASP Top 10 vulnerabilities — including custom security implementations such as hashing passwords with bcrypt/argon2, sanitizing SQL queries with parameterized statements, configuring CORS/CSP headers, validating input with Zod, and setting up JWT tokens. Invoke for authentication, authorization, input validation, encryption, OWASP Top 10 prevention, secure session management, and security hardening. For pre-built OAuth/SSO integrations or standalone security audits, consider a more specialized skill.
license: MIT
metadata:
  author: https://github.com/Jeffallan
  version: "1.1.0"
  domain: security
  triggers: security, authentication, authorization, encryption, OWASP, vulnerability, secure coding, password, JWT, OAuth
  role: specialist
  scope: implementation
  output-format: code
  related-skills: fullstack-guardian, security-reviewer, architecture-designer
---

# Secure Code Guardian

## Core Workflow

1. **Threat model** — Identify attack surface and threats
2. **Design** — Plan security controls
3. **Implement** — Write secure code with defense in depth; see code examples below
4. **Validate** — Test security controls with explicit checkpoints (see below)
5. **Document** — Record security decisions

### Validation Checkpoints

After each implementation step, verify:

- **Authentication**: Test brute-force protection (lockout/rate limit triggers), session fixation resistance, token expiration, and invalid-credential error messages (must not leak user existence).
- **Authorization**: Verify horizontal and vertical privilege escalation paths are blocked; test with tokens belonging to different roles/users.
- **Input handling**: Confirm SQL injection payloads (`' OR 1=1--`) are rejected; confirm XSS payloads (`<script>alert(1)</script>`) are escaped or rejected.
- **Headers/CORS**: Validate with a security scanner (e.g., `curl -I`, Mozilla Observatory) that security headers are present and CORS origin allowlist is correct.

## Reference Guide

Load detailed guidance based on context:

| Topic | Reference | Load When |
|-------|-----------|-----------|
| OWASP | `references/owasp-prevention.md` | OWASP Top 10 patterns |
| Authentication | `references/authentication.md` | Password hashing, JWT |
| Input Validation | `references/input-validation.md` | Zod, SQL injection |
| XSS/CSRF | `references/xss-csrf.md` | XSS prevention, CSRF |
| Headers | `references/security-headers.md` | Helmet, rate limiting |

## Constraints

### MUST DO
- Hash passwords with bcrypt/argon2 (never MD5/SHA-1/unsalted hashes)
- Use parameterized queries (never string-interpolated SQL)
- Validate and sanitize all user input before use
- Implement rate limiting on auth endpoints
- Set security headers (CSP, HSTS, X-Frame-Options)
- Log security events (failed auth, privilege escalation attempts)
- Store secrets in environment variables or secret managers (never in source code)

### MUST NOT DO
- Store passwords in plaintext or reversibly encrypted form
- Trust user input without validation
- Expose sensitive data in logs or error responses
- Use weak or deprecated algorithms (MD5, SHA-1, DES, ECB mode)
- Hardcode secrets or credentials in code

## Code Examples

### Password Hashing (bcrypt)

```typescript
import bcrypt from 'bcrypt';

const SALT_ROUNDS = 12; // minimum 10; 12 balances security and performance

export async function hashPassword(plaintext: string): Promise<string> {
  return bcrypt.hash(plaintext, SALT_ROUNDS);
}

export async function verifyPassword(plaintext: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plaintext, hash);
}
```

### Parameterized SQL Query (Node.js / pg)

```typescript
// NEVER: `SELECT * FROM users WHERE email = '${email}'`
// ALWAYS: use positional parameters
import { Pool } from 'pg';
const pool = new Pool();

export async function getUserByEmail(email: string) {
  const { rows } = await pool.query(
    'SELECT id, email, role FROM users WHERE email = $1',
    [email]  // value passed separately — never interpolated
  );
  return rows[0] ?? null;
}
```

### Input Validation with Zod

```typescript
import { z } from 'zod';

const LoginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(8).max(128),
});

export function validateLoginInput(raw: unknown) {
  const result = LoginSchema.safeParse(raw);
  if (!result.success) {
    // Return generic error — never echo raw input back
    throw new Error('Invalid credentials format');
  }
  return result.data;
}
```

### JWT Validation

```typescript
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET!; // never hardcode

export function verifyToken(token: string): jwt.JwtPayload {
  // Throws if expired, tampered, or wrong algorithm
  const payload = jwt.verify(token, JWT_SECRET, {
    algorithms: ['HS256'],   // explicitly allowlist algorithm
    issuer: 'your-app',
    audience: 'your-app',
  });
  if (typeof payload === 'string') throw new Error('Invalid token payload');
  return payload;
}
```

### Securing an Endpoint — Full Flow

```typescript
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';

const app = express();
app.use(helmet()); // sets CSP, HSTS, X-Frame-Options, etc.
app.use(express.json({ limit: '10kb' })); // limit payload size

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,                   // 10 attempts per window per IP
  standardHeaders: true,
  legacyHeaders: false,
});

app.post('/api/login', authLimiter, async (req, res) => {
  // 1. Validate input
  const { email, password } = validateLoginInput(req.body);

  // 2. Authenticate — parameterized query, constant-time compare
  const user = await getUserByEmail(email);
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    // Generic message — do not reveal whether email exists
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // 3. Authorize — issue scoped, short-lived token
  const token = jwt.sign(
    { sub: user.id, role: user.role },
    JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '15m', issuer: 'your-app', audience: 'your-app' }
  );

  // 4. Secure response — token in httpOnly cookie, not body
  res.cookie('token', token, { httpOnly: true, secure: true, sameSite: 'strict' });
  return res.json({ message: 'Authenticated' });
});
```

## Output Templates

When implementing security features, provide:
1. Secure implementation code
2. Security considerations noted
3. Configuration requirements (env vars, headers)
4. Testing recommendations

## Knowledge Reference

OWASP Top 10, bcrypt/argon2, JWT, OAuth 2.0, OIDC, CSP, CORS, rate limiting, input validation, output encoding, encryption (AES, RSA), TLS, security headers

---

## Source: secure-code-guardian/authentication.md

# Authentication

## Password Hashing

```typescript
import bcrypt from 'bcrypt';

const SALT_ROUNDS = 12;

async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

// Password requirements
const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{12,}$/;

function validatePassword(password: string): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (password.length < 12) errors.push('Minimum 12 characters');
  if (!/[a-z]/.test(password)) errors.push('Requires lowercase');
  if (!/[A-Z]/.test(password)) errors.push('Requires uppercase');
  if (!/\d/.test(password)) errors.push('Requires digit');
  if (!/[@$!%*?&]/.test(password)) errors.push('Requires special character');

  return { valid: errors.length === 0, errors };
}
```

## JWT Implementation

```typescript
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET!;
const ACCESS_TOKEN_EXPIRY = '15m';
const REFRESH_TOKEN_EXPIRY = '7d';

interface TokenPayload {
  sub: string;
  type: 'access' | 'refresh';
}

function generateAccessToken(userId: string): string {
  return jwt.sign(
    { sub: userId, type: 'access' },
    JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_EXPIRY }
  );
}

function generateRefreshToken(userId: string): string {
  return jwt.sign(
    { sub: userId, type: 'refresh' },
    JWT_SECRET,
    { expiresIn: REFRESH_TOKEN_EXPIRY }
  );
}

function verifyToken(token: string): TokenPayload {
  return jwt.verify(token, JWT_SECRET) as TokenPayload;
}
```

## Auth Middleware

```typescript
function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;

  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing token' });
  }

  try {
    const token = header.slice(7);
    const payload = verifyToken(token);

    if (payload.type !== 'access') {
      return res.status(401).json({ error: 'Invalid token type' });
    }

    req.userId = payload.sub;
    next();
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      return res.status(401).json({ error: 'Token expired' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
}
```

## Account Lockout

```typescript
const MAX_ATTEMPTS = 5;
const LOCKOUT_DURATION = 15 * 60 * 1000; // 15 minutes

async function handleLoginAttempt(email: string, success: boolean) {
  const key = `login:attempts:${email}`;

  if (success) {
    await redis.del(key);
    return;
  }

  const attempts = await redis.incr(key);
  await redis.expire(key, LOCKOUT_DURATION / 1000);

  if (attempts >= MAX_ATTEMPTS) {
    await redis.set(`login:locked:${email}`, '1', 'PX', LOCKOUT_DURATION);
    throw new Error('Account locked. Try again later.');
  }
}
```

## Quick Reference

| Practice | Implementation |
|----------|----------------|
| Password hash | bcrypt (12+ rounds) |
| Token expiry | Access: 15m, Refresh: 7d |
| Lockout | 5 attempts, 15min lockout |
| MFA | TOTP (authenticator apps) |

| JWT Claim | Purpose |
|-----------|---------|
| `sub` | User ID |
| `exp` | Expiration |
| `iat` | Issued at |
| `type` | access/refresh |

---

## Source: secure-code-guardian/input-validation.md

# Input Validation

## Zod Validation

```typescript
import { z } from 'zod';

const UserSchema = z.object({
  email: z.string().email().max(255),
  name: z.string().min(1).max(100).regex(/^[\w\s-]+$/),
  age: z.number().int().min(0).max(150).optional(),
  role: z.enum(['user', 'admin']).default('user'),
});

function validateUser(data: unknown) {
  return UserSchema.parse(data); // Throws on invalid
}

// Safe parse (no throw)
const result = UserSchema.safeParse(data);
if (!result.success) {
  console.error(result.error.issues);
}
```

## SQL Injection Prevention

```typescript
// ❌ NEVER do this
const bad = `SELECT * FROM users WHERE id = ${userId}`;
const bad2 = `SELECT * FROM users WHERE name = '${name}'`;

// ✅ Parameterized queries
const good = await db.query(
  'SELECT * FROM users WHERE id = $1 AND name = $2',
  [userId, name]
);

// ✅ Use ORM
const user = await prisma.user.findFirst({
  where: { id: userId, name: name }
});

// ✅ Query builder
const user = await knex('users')
  .where({ id: userId, name: name })
  .first();
```

## Path Traversal Prevention

```typescript
import path from 'path';

// ❌ Vulnerable
const vulnerable = path.join('/uploads', userInput);

// ✅ Safe - validate and sanitize
function getSecurePath(baseDir: string, userInput: string): string {
  // Remove any path traversal attempts
  const sanitized = path.basename(userInput);

  // Resolve and verify it's within base directory
  const fullPath = path.resolve(baseDir, sanitized);

  if (!fullPath.startsWith(path.resolve(baseDir))) {
    throw new Error('Invalid path');
  }

  return fullPath;
}
```

## Command Injection Prevention

```typescript
import { execFile } from 'child_process';

// ❌ Never use exec with user input
exec(`convert ${userInput}`); // Vulnerable!

// ✅ Use execFile with arguments array
execFile('convert', ['-resize', '100x100', safeFilename], (error, stdout) => {
  // ...
});

// ✅ Better: Use library functions instead of shell
import sharp from 'sharp';
await sharp(inputPath).resize(100, 100).toFile(outputPath);
```

## URL Validation

```typescript
function validateUrl(input: string, allowedHosts: string[]): URL {
  const url = new URL(input);

  // Check protocol
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Invalid protocol');
  }

  // Check host allowlist
  if (!allowedHosts.includes(url.hostname)) {
    throw new Error('Host not allowed');
  }

  return url;
}
```

## File Upload Validation

```typescript
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/gif'];
const MAX_SIZE = 5 * 1024 * 1024; // 5MB

function validateUpload(file: Express.Multer.File) {
  if (!ALLOWED_TYPES.includes(file.mimetype)) {
    throw new Error('Invalid file type');
  }

  if (file.size > MAX_SIZE) {
    throw new Error('File too large');
  }

  // Verify magic bytes (not just extension)
  const buffer = fs.readFileSync(file.path);
  const type = fileType.fromBuffer(buffer);

  if (!type || !ALLOWED_TYPES.includes(type.mime)) {
    throw new Error('Invalid file content');
  }
}
```

## Quick Reference

| Input Type | Validation |
|------------|------------|
| Email | Regex + max length |
| URL | Protocol + host allowlist |
| File path | basename + resolve check |
| SQL | Parameterized queries |
| Command | execFile + no shell |
| File upload | Type + size + magic bytes |

---

## Source: secure-code-guardian/owasp-prevention.md

# OWASP Top 10 Prevention

## OWASP Top 10 Quick Reference

| # | Vulnerability | Prevention |
|---|---------------|------------|
| 1 | Injection | Parameterized queries, ORMs |
| 2 | Broken Auth | Strong passwords, MFA, secure sessions |
| 3 | Sensitive Data | Encryption at rest/transit |
| 4 | XXE | Disable DTDs, use JSON |
| 5 | Broken Access | Deny by default, server-side validation |
| 6 | Misconfig | Security headers, disable defaults |
| 7 | XSS | Output encoding, CSP |
| 8 | Insecure Deserialization | Schema validation, allowlists |
| 9 | Known Vulnerabilities | Dependency scanning |
| 10 | Insufficient Logging | Log security events |

## A01: Injection Prevention

```typescript
// SQL Injection - Use parameterized queries
// ❌ Bad
const bad = `SELECT * FROM users WHERE id = ${userId}`;

// ✅ Good
const good = await db.query('SELECT * FROM users WHERE id = $1', [userId]);

// ✅ Good - Use ORM
const user = await prisma.user.findUnique({ where: { id: userId } });

// Command Injection - Avoid shell execution
// ❌ Bad
exec(`ls ${userInput}`);

// ✅ Good - Use library functions
const files = fs.readdirSync(safeDirectory);
```

## A02: Broken Authentication

```typescript
// Use bcrypt for passwords
const hash = await bcrypt.hash(password, 12);
const isValid = await bcrypt.compare(password, hash);

// Implement account lockout
if (failedAttempts >= 5) {
  await lockAccount(userId, 15 * 60 * 1000); // 15 min
}

// Use secure session configuration
app.use(session({
  secret: process.env.SESSION_SECRET,
  cookie: {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    maxAge: 15 * 60 * 1000, // 15 minutes
  },
}));
```

## A03: Sensitive Data Exposure

```typescript
// Encrypt sensitive data at rest
import crypto from 'crypto';

function encrypt(text: string, key: Buffer): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  // ... encryption logic
}

// Use HTTPS only
app.use((req, res, next) => {
  if (!req.secure) {
    return res.redirect(`https://${req.hostname}${req.url}`);
  }
  next();
});
```

## A05: Broken Access Control

```typescript
// Always validate on server side
async function getResource(userId: string, resourceId: string) {
  const resource = await db.resource.findUnique({ where: { id: resourceId } });

  // Verify ownership
  if (resource.ownerId !== userId) {
    throw new ForbiddenError('Access denied');
  }

  return resource;
}

// Use role-based access
function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  };
}
```

## A07: XSS Prevention

```typescript
// Use Content Security Policy
app.use(helmet.contentSecurityPolicy({
  directives: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'"],
  },
}));

// Sanitize user input for HTML
import DOMPurify from 'dompurify';
const clean = DOMPurify.sanitize(userInput);
```

## Quick Reference

| Attack | Defense |
|--------|---------|
| SQL Injection | Parameterized queries |
| XSS | Output encoding, CSP |
| CSRF | CSRF tokens |
| IDOR | Authorization checks |
| Command Injection | Avoid exec(), validate input |

---

## Source: secure-code-guardian/security-headers.md

# Security Headers

## Helmet (Express)

```typescript
import helmet from 'helmet';

app.use(helmet()); // Enable all defaults

// Or configure individually
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
    },
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true,
  },
}));
```

## Manual Headers

```typescript
app.use((req, res, next) => {
  // Prevent clickjacking
  res.setHeader('X-Frame-Options', 'DENY');

  // Prevent MIME sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // HSTS (HTTPS only)
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');

  // Referrer policy
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  // Permissions policy
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');

  next();
});
```

## Rate Limiting

```typescript
import rateLimit from 'express-rate-limit';

// General API rate limit
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  message: { error: 'Too many requests' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api/', apiLimiter);

// Strict limit for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many login attempts' },
  skipSuccessfulRequests: true,
});

app.post('/api/login', authLimiter, loginHandler);
app.post('/api/register', authLimiter, registerHandler);
```

## CORS Configuration

```typescript
import cors from 'cors';

// Strict CORS
app.use(cors({
  origin: ['https://example.com', 'https://app.example.com'],
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  maxAge: 86400, // Cache preflight for 24 hours
}));

// Dynamic origin validation
app.use(cors({
  origin: (origin, callback) => {
    const allowedOrigins = ['https://example.com'];
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
}));
```

## Cookie Security

```typescript
res.cookie('session', token, {
  httpOnly: true,      // No JavaScript access
  secure: true,        // HTTPS only
  sameSite: 'strict',  // CSRF protection
  maxAge: 900000,      // 15 minutes
  path: '/',
  domain: '.example.com',
});
```

## Quick Reference

| Header | Value | Purpose |
|--------|-------|---------|
| X-Frame-Options | DENY | Clickjacking |
| X-Content-Type-Options | nosniff | MIME sniffing |
| Strict-Transport-Security | max-age=31536000 | Force HTTPS |
| Content-Security-Policy | default-src 'self' | XSS |
| Referrer-Policy | strict-origin-when-cross-origin | Privacy |

| Cookie Flag | Purpose |
|-------------|---------|
| httpOnly | No JS access |
| secure | HTTPS only |
| sameSite=strict | CSRF protection |
| maxAge | Expiration |

---

## Source: secure-code-guardian/xss-csrf.md

# XSS & CSRF Prevention

## XSS Prevention

### Output Encoding

```typescript
// React automatically escapes by default
function SafeComponent({ userInput }: { userInput: string }) {
  return <div>{userInput}</div>; // Safe - auto-escaped
}

// If you must render HTML, sanitize first
import DOMPurify from 'dompurify';

function HtmlContent({ html }: { html: string }) {
  return (
    <div
      dangerouslySetInnerHTML={{
        __html: DOMPurify.sanitize(html)
      }}
    />
  );
}
```

### Content Security Policy

```typescript
import helmet from 'helmet';

app.use(helmet.contentSecurityPolicy({
  directives: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", "data:", "https:"],
    connectSrc: ["'self'", "https://api.example.com"],
    fontSrc: ["'self'"],
    objectSrc: ["'none'"],
    frameSrc: ["'none'"],
    upgradeInsecureRequests: [],
  },
}));
```

### Input Sanitization

```typescript
import DOMPurify from 'dompurify';

// Sanitize HTML
const clean = DOMPurify.sanitize(dirty);

// Sanitize with config
const cleanStrict = DOMPurify.sanitize(dirty, {
  ALLOWED_TAGS: ['b', 'i', 'em', 'strong', 'a'],
  ALLOWED_ATTR: ['href'],
});

// Strip all HTML
const textOnly = DOMPurify.sanitize(dirty, { ALLOWED_TAGS: [] });
```

## CSRF Prevention

### Synchronizer Token Pattern

```typescript
import csrf from 'csurf';

const csrfProtection = csrf({ cookie: true });

// Add to forms
app.get('/form', csrfProtection, (req, res) => {
  res.render('form', { csrfToken: req.csrfToken() });
});

// Validate on submission
app.post('/submit', csrfProtection, (req, res) => {
  // Token validated automatically
});
```

### Double Submit Cookie

```typescript
// Set CSRF cookie
res.cookie('csrf', token, {
  httpOnly: false, // Must be readable by JS
  secure: true,
  sameSite: 'strict',
});

// Client sends in header
fetch('/api/action', {
  method: 'POST',
  headers: {
    'X-CSRF-Token': getCookie('csrf'),
  },
});

// Server validates
if (req.cookies.csrf !== req.headers['x-csrf-token']) {
  return res.status(403).json({ error: 'CSRF validation failed' });
}
```

### SameSite Cookies

```typescript
// Modern CSRF protection
app.use(session({
  cookie: {
    httpOnly: true,
    secure: true,
    sameSite: 'strict', // Or 'lax' for GET requests
  },
}));
```

## HTTP Headers

```typescript
// Security headers
app.use((req, res, next) => {
  // Prevent clickjacking
  res.setHeader('X-Frame-Options', 'DENY');

  // Prevent MIME sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // XSS filter (legacy)
  res.setHeader('X-XSS-Protection', '1; mode=block');

  // Referrer policy
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  next();
});
```

## Quick Reference

| Attack | Prevention |
|--------|------------|
| Reflected XSS | Output encoding |
| Stored XSS | Input sanitization + encoding |
| DOM XSS | Avoid innerHTML, use textContent |
| CSRF | Tokens + SameSite cookies |

| Header | Purpose |
|--------|---------|
| CSP | Script/resource restrictions |
| X-Frame-Options | Clickjacking |
| X-Content-Type-Options | MIME sniffing |
| SameSite | CSRF protection |

---
