# Atlassian MCP Integration
---

## Source: SKILL.md

---
name: atlassian-mcp
description: Integrates with Atlassian products to manage project tracking and documentation via MCP protocol. Use when querying Jira issues with JQL filters, creating and updating tickets with custom fields, searching or editing Confluence pages with CQL, managing sprints and backlogs, setting up MCP server authentication, syncing documentation, or debugging Atlassian API integrations.
license: MIT
metadata:
  author: https://github.com/Jeffallan
  version: "1.1.0"
  domain: platform
  triggers: Jira, Confluence, Atlassian, MCP, tickets, issues, wiki, JQL, CQL, sprint, backlog, project management
  role: expert
  scope: implementation
  output-format: code
  related-skills: mcp-developer, api-designer, security-reviewer
---

# Atlassian MCP Expert

## When to Use This Skill

- Querying Jira issues with JQL filters
- Searching or creating Confluence pages
- Automating sprint workflows and backlog management
- Setting up MCP server authentication (OAuth/API tokens)
- Syncing meeting notes to Jira tickets
- Generating documentation from issue data
- Debugging Atlassian API integration issues
- Choosing between official vs open-source MCP servers

## Core Workflow

1. **Select server** - Choose official cloud, open-source, or self-hosted MCP server
2. **Authenticate** - Configure OAuth 2.1, API tokens, or PAT credentials
3. **Design queries** - Write JQL for Jira, CQL for Confluence; validate with `maxResults=1` before full execution
4. **Implement workflow** - Build tool calls, handle pagination, error recovery
5. **Verify permissions** - Confirm required scopes with a read-only probe before any write or bulk operation
6. **Deploy** - Configure IDE integration, test permissions, monitor rate limits

## Reference Guide

Load detailed guidance based on context:

| Topic | Reference | Load When |
|-------|-----------|-----------|
| Server Setup | `references/mcp-server-setup.md` | Installation, choosing servers, configuration |
| Jira Operations | `references/jira-queries.md` | JQL syntax, issue CRUD, sprints, boards, issue linking |
| Confluence Ops | `references/confluence-operations.md` | CQL search, page creation, spaces, comments |
| Authentication | `references/authentication-patterns.md` | OAuth 2.0, API tokens, permission scopes |
| Common Workflows | `references/common-workflows.md` | Issue triage, doc sync, sprint automation |

## Quick-Start Examples

### JQL Query Samples
```
# Open issues assigned to current user in a sprint
project = PROJ AND status = "In Progress" AND assignee = currentUser() ORDER BY priority DESC

# Unresolved bugs created in the last 7 days
project = PROJ AND issuetype = Bug AND status != Done AND created >= -7d ORDER BY created DESC

# Validate before bulk: test with maxResults=1 first
project = PROJ AND sprint in openSprints() AND status = Open ORDER BY created DESC
```

### CQL Query Samples
```
# Find pages updated in a specific space recently
space = "ENG" AND type = page AND lastModified >= "2024-01-01" ORDER BY lastModified DESC

# Search page text for a keyword
space = "ENG" AND type = page AND text ~ "deployment runbook"
```

### Minimal MCP Server Configuration
```json
{
  "mcpServers": {
    "atlassian": {
      "command": "npx",
      "args": ["-y", "@sooperset/mcp-atlassian"],
      "env": {
        "JIRA_URL": "https://your-domain.atlassian.net",
        "JIRA_EMAIL": "user@example.com",
        "JIRA_API_TOKEN": "${JIRA_API_TOKEN}",
        "CONFLUENCE_URL": "https://your-domain.atlassian.net/wiki",
        "CONFLUENCE_EMAIL": "user@example.com",
        "CONFLUENCE_API_TOKEN": "${CONFLUENCE_API_TOKEN}"
      }
    }
  }
}
```
> **Note:** Always load `JIRA_API_TOKEN` and `CONFLUENCE_API_TOKEN` from environment variables or a secrets manager — never hardcode credentials.

## Constraints

### MUST DO
- Respect user permissions and workspace access controls
- Validate JQL/CQL queries before execution (use `maxResults=1` probe first)
- Handle rate limits with exponential backoff
- Use pagination for large result sets (50-100 items per page)
- Implement error recovery for network failures
- Log API calls for debugging and audit trails
- Test with read-only operations first
- Document required permission scopes
- Confirm before any write or bulk operation against production data

### MUST NOT DO
- Hardcode API tokens or OAuth secrets in code
- Ignore rate limit headers from Atlassian APIs
- Create issues without validating required fields
- Skip input sanitization on user-provided query strings
- Deploy without testing permission boundaries
- Update production data without confirmation prompts
- Mix different authentication methods in same session
- Expose sensitive issue data in logs or error messages

## Output Templates

When implementing Atlassian MCP features, provide:
1. MCP server configuration (JSON/environment vars)
2. Query examples (JQL/CQL with explanations)
3. Tool call implementation with error handling
4. Authentication setup instructions
5. Brief explanation of permission requirements

---

## Source: authentication-patterns.md

# Authentication Patterns

---

## Authentication Methods Overview

| Method | Platform | Use Case | Security Level |
|--------|----------|----------|----------------|
| OAuth 2.1 | Cloud | User-facing apps, integrations | Highest |
| API Token | Cloud | Personal automation, scripts | Medium |
| PAT | Server/DC | Server integrations | Medium |
| Basic Auth | Legacy | Deprecated, avoid | Low |

## OAuth 2.1 (Atlassian Cloud)

### Authorization Code Flow

For applications that act on behalf of users.

**Step 1: Register Your App**

1. Go to [developer.atlassian.com](https://developer.atlassian.com/console/myapps/)
2. Create new app
3. Configure OAuth 2.0 (3LO)
4. Add callback URL
5. Request necessary scopes

**Step 2: Authorization Request**

```typescript
const authUrl = new URL('https://auth.atlassian.com/authorize');
authUrl.searchParams.set('audience', 'api.atlassian.com');
authUrl.searchParams.set('client_id', CLIENT_ID);
authUrl.searchParams.set('scope', 'read:jira-work write:jira-work read:confluence-content.all write:confluence-content');
authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
authUrl.searchParams.set('state', generateState());
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('prompt', 'consent');

// Redirect user to authUrl.toString()
```

**Step 3: Exchange Code for Token**

```typescript
async function exchangeCodeForToken(code: string): Promise<TokenResponse> {
  const response = await fetch('https://auth.atlassian.com/oauth/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      redirect_uri: REDIRECT_URI,
    }),
  });

  if (!response.ok) {
    throw new Error(`Token exchange failed: ${response.statusText}`);
  }

  return response.json();
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
  token_type: 'Bearer';
}
```

**Step 4: Refresh Token**

```typescript
async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const response = await fetch('https://auth.atlassian.com/oauth/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: refreshToken,
    }),
  });

  return response.json();
}
```

**Step 5: Get Accessible Resources**

```typescript
async function getAccessibleResources(accessToken: string): Promise<Resource[]> {
  const response = await fetch(
    'https://api.atlassian.com/oauth/token/accessible-resources',
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    }
  );

  return response.json();
}

interface Resource {
  id: string;        // Cloud ID
  name: string;      // Site name
  url: string;       // https://your-site.atlassian.net
  scopes: string[];
  avatarUrl: string;
}
```

### OAuth Scopes Reference

**Jira Scopes:**

| Scope | Description |
|-------|-------------|
| `read:jira-work` | Read issues, projects, boards |
| `write:jira-work` | Create/update issues |
| `manage:jira-project` | Manage project settings |
| `manage:jira-configuration` | Manage global settings |
| `read:jira-user` | Read user profiles |
| `manage:jira-data-provider` | Data provider integrations |

**Confluence Scopes:**

| Scope | Description |
|-------|-------------|
| `read:confluence-content.all` | Read all content |
| `write:confluence-content` | Create/update content |
| `read:confluence-content.summary` | Read content summaries |
| `read:confluence-space.summary` | Read space summaries |
| `write:confluence-space` | Create/manage spaces |
| `read:confluence-user` | Read user profiles |

**Granular Scopes (v2):**

```
read:issue-details:jira
write:issue:jira
read:sprint:jira-software
write:sprint:jira-software
read:page:confluence
write:page:confluence
read:comment:confluence
write:comment:confluence
```

## API Tokens (Atlassian Cloud)

### Creating API Token

1. Go to [id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens)
2. Click "Create API token"
3. Give it a descriptive label
4. Copy token immediately (shown only once)

### Using API Token

```typescript
// Basic authentication with API token
const credentials = Buffer.from(`${email}:${apiToken}`).toString('base64');

const response = await fetch('https://your-site.atlassian.net/rest/api/3/myself', {
  headers: {
    Authorization: `Basic ${credentials}`,
    Accept: 'application/json',
  },
});

// For MCP server configuration
const config = {
  JIRA_URL: 'https://your-site.atlassian.net',
  JIRA_USERNAME: 'your-email@company.com',
  JIRA_API_TOKEN: 'your-api-token',
};
```

### Token Security Best Practices

```typescript
// Store tokens securely
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { SecretsManager } from '@aws-sdk/client-secrets-manager';

// Option 1: Environment variables (development only)
const token = process.env.ATLASSIAN_API_TOKEN;

// Option 2: GCP Secret Manager
async function getTokenFromGCP(secretName: string): Promise<string> {
  const client = new SecretManagerServiceClient();
  const [version] = await client.accessSecretVersion({
    name: `projects/my-project/secrets/${secretName}/versions/latest`,
  });
  return version.payload?.data?.toString() || '';
}

// Option 3: AWS Secrets Manager
async function getTokenFromAWS(secretName: string): Promise<string> {
  const client = new SecretsManager({ region: 'us-east-1' });
  const response = await client.getSecretValue({ SecretId: secretName });
  return response.SecretString || '';
}

// Option 4: HashiCorp Vault
async function getTokenFromVault(path: string): Promise<string> {
  const response = await fetch(`${VAULT_ADDR}/v1/${path}`, {
    headers: { 'X-Vault-Token': VAULT_TOKEN },
  });
  const data = await response.json();
  return data.data.data.token;
}
```

## Personal Access Tokens (Server/Data Center)

### Creating PAT

**Jira Server/DC:**
1. Profile > Personal Access Tokens
2. Create token
3. Set expiration date
4. Select permissions

**Confluence Server/DC:**
1. Profile > Settings > Personal Access Tokens
2. Create token
3. Configure permissions

### Using PAT

```typescript
// Bearer token authentication
const response = await fetch('https://jira.internal.company.com/rest/api/2/myself', {
  headers: {
    Authorization: `Bearer ${personalAccessToken}`,
    Accept: 'application/json',
  },
});

// MCP server configuration
const config = {
  JIRA_URL: 'https://jira.internal.company.com',
  JIRA_PERSONAL_TOKEN: 'your-personal-access-token',
};
```

### PAT Permissions

| Permission | Jira | Confluence |
|------------|------|------------|
| Read | Browse projects, view issues | View pages |
| Write | Create/edit issues | Create/edit pages |
| Admin | Project administration | Space administration |

## Token Management

### Token Lifecycle Manager

```typescript
interface TokenInfo {
  accessToken: string;
  refreshToken?: string;
  expiresAt: Date;
  scopes: string[];
}

class TokenManager {
  private tokenInfo: TokenInfo | null = null;
  private refreshThreshold = 5 * 60 * 1000; // 5 minutes

  async getValidToken(): Promise<string> {
    if (!this.tokenInfo) {
      throw new Error('Not authenticated');
    }

    // Check if token needs refresh
    const timeUntilExpiry = this.tokenInfo.expiresAt.getTime() - Date.now();

    if (timeUntilExpiry < this.refreshThreshold) {
      await this.refreshToken();
    }

    return this.tokenInfo.accessToken;
  }

  private async refreshToken(): Promise<void> {
    if (!this.tokenInfo?.refreshToken) {
      throw new Error('No refresh token available');
    }

    const response = await refreshAccessToken(this.tokenInfo.refreshToken);

    this.tokenInfo = {
      accessToken: response.access_token,
      refreshToken: response.refresh_token || this.tokenInfo.refreshToken,
      expiresAt: new Date(Date.now() + response.expires_in * 1000),
      scopes: response.scope.split(' '),
    };
  }

  isAuthenticated(): boolean {
    return this.tokenInfo !== null && this.tokenInfo.expiresAt > new Date();
  }

  getScopes(): string[] {
    return this.tokenInfo?.scopes || [];
  }

  hasScope(scope: string): boolean {
    return this.getScopes().includes(scope);
  }
}
```

### Token Rotation Strategy

```typescript
class TokenRotationManager {
  private rotationInterval = 30 * 24 * 60 * 60 * 1000; // 30 days

  async checkAndRotate(tokenCreatedAt: Date): Promise<boolean> {
    const age = Date.now() - tokenCreatedAt.getTime();

    if (age > this.rotationInterval) {
      console.warn('API token is due for rotation');
      return true;
    }

    return false;
  }

  async sendRotationReminder(email: string, tokenLabel: string): Promise<void> {
    // Integrate with your notification system
    await sendEmail({
      to: email,
      subject: 'Atlassian API Token Rotation Reminder',
      body: `Your API token "${tokenLabel}" is due for rotation.
             Please create a new token and update your integrations.`,
    });
  }
}
```

## Permission Verification

### Check Current Permissions

```typescript
async function verifyPermissions(
  client: MCPClient,
  requiredOperations: string[]
): Promise<PermissionReport> {
  const report: PermissionReport = {
    hasAllPermissions: true,
    details: [],
  };

  for (const operation of requiredOperations) {
    try {
      switch (operation) {
        case 'read:jira':
          await client.callTool({
            name: 'jira_get_issue',
            arguments: { issue_key: 'TEST-1' },
          });
          break;
        case 'write:jira':
          // Create and immediately delete a test issue
          const created = await client.callTool({
            name: 'jira_create_issue',
            arguments: {
              project_key: 'TEST',
              issue_type: 'Task',
              summary: '[Permission Test] Delete me',
            },
          });
          // Clean up
          await client.callTool({
            name: 'jira_delete_issue',
            arguments: { issue_key: JSON.parse(created.content[0].text).key },
          });
          break;
        case 'read:confluence':
          await client.callTool({
            name: 'confluence_search',
            arguments: { cql: 'type = page', limit: 1 },
          });
          break;
      }

      report.details.push({ operation, status: 'granted' });
    } catch (error: any) {
      report.hasAllPermissions = false;
      report.details.push({
        operation,
        status: 'denied',
        error: error.message,
      });
    }
  }

  return report;
}
```

## Security Checklist

### Do:
- Use OAuth 2.1 for user-facing applications
- Store secrets in dedicated secrets management systems
- Implement token rotation policies
- Use minimal required scopes
- Log authentication events (without secrets)
- Implement rate limiting at application level
- Validate tokens before use

### Don't:
- Hardcode tokens in source code
- Log tokens or secrets
- Share tokens between environments
- Use Basic Auth (deprecated)
- Request more scopes than needed
- Store tokens in browser localStorage
- Commit `.env` files with real credentials

### Environment Configuration Template

```bash
# .env.example (commit this)
ATLASSIAN_SITE_URL=https://your-site.atlassian.net
ATLASSIAN_AUTH_TYPE=oauth  # or 'api_token' or 'pat'

# OAuth settings (if using OAuth)
ATLASSIAN_CLIENT_ID=
ATLASSIAN_CLIENT_SECRET=

# API Token settings (if using API token)
ATLASSIAN_USERNAME=
ATLASSIAN_API_TOKEN=

# PAT settings (if using Server/DC)
ATLASSIAN_PERSONAL_TOKEN=
```

```bash
# .gitignore
.env
.env.local
.env.*.local
credentials.json
**/secrets/**
```

## Troubleshooting

### Common Authentication Errors

**401 Unauthorized:**
- Invalid or expired token
- Wrong authentication method
- Missing Authorization header

**403 Forbidden:**
- Token valid but lacks required scope
- Resource-level permission denied
- IP allowlist blocking request

**Token refresh fails:**
- Refresh token expired (after 90 days of inactivity)
- Client secret changed
- App permissions revoked

### Debug Authentication

```typescript
async function debugAuth(token: string): Promise<void> {
  // Check token validity
  const meResponse = await fetch(
    'https://api.atlassian.com/me',
    { headers: { Authorization: `Bearer ${token}` } }
  );

  console.log('Token status:', meResponse.status);

  if (meResponse.ok) {
    const me = await meResponse.json();
    console.log('Authenticated as:', me.email);
  }

  // Check accessible resources
  const resourcesResponse = await fetch(
    'https://api.atlassian.com/oauth/token/accessible-resources',
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (resourcesResponse.ok) {
    const resources = await resourcesResponse.json();
    console.log('Accessible sites:', resources.map((r: any) => r.name));
  }
}
```

## Related References

- `mcp-server-setup.md` - Server configuration with credentials
- `jira-queries.md` - Operations that require authentication
- `confluence-operations.md` - Content operations with auth

---

## Source: common-workflows.md

# Common Workflows

---

## Issue Triage Workflow

Automatically categorize, prioritize, and route incoming issues.

### Triage Bot Implementation

```typescript
interface TriageResult {
  issueKey: string;
  category: string;
  priority: string;
  assignee: string | null;
  labels: string[];
  actions: string[];
}

async function triageNewIssue(
  client: MCPClient,
  issueKey: string
): Promise<TriageResult> {
  // Get issue details
  const issueResult = await client.callTool({
    name: "jira_get_issue",
    arguments: {
      issue_key: issueKey,
      expand: ["changelog"]
    }
  });

  const issue = JSON.parse(issueResult.content[0].text);
  const result: TriageResult = {
    issueKey,
    category: "uncategorized",
    priority: issue.fields.priority?.name || "Medium",
    assignee: null,
    labels: [],
    actions: []
  };

  // Categorize based on content
  const summary = issue.fields.summary.toLowerCase();
  const description = (issue.fields.description?.content?.[0]?.content?.[0]?.text || "").toLowerCase();
  const text = `${summary} ${description}`;

  // Category detection
  if (text.match(/\b(crash|down|outage|critical|emergency)\b/)) {
    result.category = "incident";
    result.priority = "Highest";
    result.labels.push("incident", "urgent");
  } else if (text.match(/\b(bug|error|fail|broken|doesn't work)\b/)) {
    result.category = "bug";
    result.labels.push("bug", "needs-investigation");
  } else if (text.match(/\b(feature|enhancement|request|add|improve)\b/)) {
    result.category = "feature";
    result.labels.push("feature-request");
  } else if (text.match(/\b(docs|documentation|readme|guide)\b/)) {
    result.category = "documentation";
    result.labels.push("documentation");
  }

  // Component detection for routing
  const componentMap: Record<string, { component: string; team: string }> = {
    "api|rest|endpoint": { component: "API", team: "backend-team" },
    "ui|button|page|screen|css": { component: "Frontend", team: "frontend-team" },
    "database|sql|query|migration": { component: "Database", team: "data-team" },
    "auth|login|password|sso": { component: "Authentication", team: "security-team" },
    "deploy|ci|cd|pipeline": { component: "DevOps", team: "platform-team" }
  };

  for (const [pattern, { component, team }] of Object.entries(componentMap)) {
    if (text.match(new RegExp(`\\b(${pattern})\\b`))) {
      result.labels.push(component.toLowerCase());
      result.actions.push(`Route to ${team}`);
      break;
    }
  }

  // Apply triage results
  await client.callTool({
    name: "jira_update_issue",
    arguments: {
      issue_key: issueKey,
      fields: {
        priority: { name: result.priority },
        labels: [...new Set([...issue.fields.labels || [], ...result.labels])]
      }
    }
  });

  // Add triage comment
  await client.callTool({
    name: "jira_add_comment",
    arguments: {
      issue_key: issueKey,
      body: `*Automated Triage Results*

Category: ${result.category}
Priority: ${result.priority}
Labels added: ${result.labels.join(", ")}

${result.actions.length > 0 ? `Recommended actions:\n${result.actions.map(a => `- ${a}`).join("\n")}` : ""}`
    }
  });

  return result;
}
```

### Bulk Triage New Issues

```typescript
async function triageBacklog(client: MCPClient, projectKey: string): Promise<void> {
  // Find untriaged issues
  const searchResult = await client.callTool({
    name: "jira_search",
    arguments: {
      jql: `project = ${projectKey} AND labels IS EMPTY AND created >= -7d AND resolution IS EMPTY`,
      max_results: 50,
      fields: ["summary", "description", "priority", "labels"]
    }
  });

  const response = JSON.parse(searchResult.content[0].text);
  console.log(`Found ${response.total} issues to triage`);

  for (const issue of response.issues) {
    const result = await triageNewIssue(client, issue.key);
    console.log(`Triaged ${issue.key}: ${result.category} (${result.priority})`);

    // Rate limiting
    await delay(500);
  }
}
```

## Documentation Sync Workflow

Keep Confluence documentation in sync with Jira issues.

### Generate Release Notes

```typescript
async function generateReleaseNotes(
  client: MCPClient,
  projectKey: string,
  version: string,
  confluenceSpaceKey: string
): Promise<string> {
  // Get all issues in the release
  const searchResult = await client.callTool({
    name: "jira_search",
    arguments: {
      jql: `project = ${projectKey} AND fixVersion = "${version}" AND resolution = Done ORDER BY issuetype, priority DESC`,
      max_results: 200,
      fields: ["summary", "issuetype", "priority", "assignee", "labels"]
    }
  });

  const response = JSON.parse(searchResult.content[0].text);

  // Group by issue type
  const grouped: Record<string, any[]> = {};
  for (const issue of response.issues) {
    const type = issue.fields.issuetype.name;
    if (!grouped[type]) grouped[type] = [];
    grouped[type].push(issue);
  }

  // Build Confluence page content
  let content = `
<h2>Release ${version}</h2>
<p>Released on ${new Date().toISOString().split('T')[0]}</p>

<ac:structured-macro ac:name="toc">
  <ac:parameter ac:name="maxLevel">2</ac:parameter>
</ac:structured-macro>

<h2>Summary</h2>
<p>This release includes ${response.total} changes.</p>
<table>
  <tr><th>Type</th><th>Count</th></tr>
  ${Object.entries(grouped).map(([type, issues]) =>
    `<tr><td>${type}</td><td>${issues.length}</td></tr>`
  ).join('')}
</table>
`;

  // Add sections for each issue type
  const typeOrder = ["New Feature", "Improvement", "Bug", "Task"];
  const orderedTypes = [...new Set([...typeOrder, ...Object.keys(grouped)])];

  for (const type of orderedTypes) {
    if (!grouped[type]) continue;

    content += `
<h2>${type}s</h2>
<table>
  <tr><th>Key</th><th>Summary</th><th>Assignee</th></tr>
  ${grouped[type].map(issue => `
    <tr>
      <td><ac:structured-macro ac:name="jira"><ac:parameter ac:name="key">${issue.key}</ac:parameter></ac:structured-macro></td>
      <td>${escapeHtml(issue.fields.summary)}</td>
      <td>${issue.fields.assignee?.displayName || 'Unassigned'}</td>
    </tr>
  `).join('')}
</table>
`;
  }

  // Create or update Confluence page
  const pageTitle = `Release Notes - ${version}`;

  // Check if page exists
  const existingSearch = await client.callTool({
    name: "confluence_search",
    arguments: {
      cql: `space = "${confluenceSpaceKey}" AND title = "${pageTitle}"`,
      limit: 1
    }
  });

  const existingResults = JSON.parse(existingSearch.content[0].text);

  if (existingResults.results.length > 0) {
    // Update existing page
    const pageId = existingResults.results[0].id;
    const currentVersion = existingResults.results[0].version.number;

    await client.callTool({
      name: "confluence_update_page",
      arguments: {
        page_id: pageId,
        title: pageTitle,
        body: content,
        version_number: currentVersion + 1,
        version_message: `Updated release notes for ${version}`
      }
    });

    return pageId;
  } else {
    // Create new page
    const newPage = await client.callTool({
      name: "confluence_create_page",
      arguments: {
        space_key: confluenceSpaceKey,
        title: pageTitle,
        body: content,
        labels: ["release-notes", `version-${version.replace(/\./g, '-')}`]
      }
    });

    return JSON.parse(newPage.content[0].text).id;
  }
}
```

### Sync Meeting Notes to Jira

```typescript
interface ActionItem {
  description: string;
  assignee: string;
  dueDate?: string;
}

async function syncMeetingNotes(
  client: MCPClient,
  confluencePageId: string,
  jiraProjectKey: string
): Promise<string[]> {
  // Get meeting notes content
  const pageResult = await client.callTool({
    name: "confluence_get_page",
    arguments: {
      page_id: confluencePageId,
      expand: ["body.storage"]
    }
  });

  const page = JSON.parse(pageResult.content[0].text);
  const content = page.body.storage.value;

  // Extract action items (look for checkbox patterns)
  const actionItems = extractActionItems(content);
  const createdIssues: string[] = [];

  for (const item of actionItems) {
    // Create Jira task
    const newIssue = await client.callTool({
      name: "jira_create_issue",
      arguments: {
        project_key: jiraProjectKey,
        issue_type: "Task",
        summary: item.description,
        description: {
          type: "doc",
          version: 1,
          content: [{
            type: "paragraph",
            content: [{
              type: "text",
              text: `Action item from meeting: ${page.title}\n\nSource: ${page._links.webui}`
            }]
          }]
        },
        assignee: item.assignee,
        due_date: item.dueDate,
        labels: ["meeting-action", "auto-created"]
      }
    });

    const issueKey = JSON.parse(newIssue.content[0].text).key;
    createdIssues.push(issueKey);
  }

  // Update Confluence page with Jira links
  if (createdIssues.length > 0) {
    const jiraLinksSection = `
<h2>Linked Jira Issues</h2>
<ac:structured-macro ac:name="jira">
  <ac:parameter ac:name="jqlQuery">key IN (${createdIssues.join(',')})</ac:parameter>
  <ac:parameter ac:name="columns">key,summary,status,assignee</ac:parameter>
</ac:structured-macro>
`;

    await client.callTool({
      name: "confluence_update_page",
      arguments: {
        page_id: confluencePageId,
        title: page.title,
        body: content + jiraLinksSection,
        version_number: page.version.number + 1
      }
    });
  }

  return createdIssues;
}

function extractActionItems(html: string): ActionItem[] {
  // Parse action items from common patterns
  const items: ActionItem[] = [];

  // Pattern: [x] or [ ] followed by @mention and task description
  const taskPattern = /\[[ x]\]\s*@([a-zA-Z.]+)\s*[-:]\s*(.+?)(?=<|$)/gi;
  let match;

  while ((match = taskPattern.exec(html)) !== null) {
    items.push({
      assignee: match[1],
      description: match[2].trim()
    });
  }

  return items;
}
```

## Sprint Automation Workflow

Automate sprint ceremonies and reporting.

### Sprint Planning Assistant

```typescript
interface SprintPlanningReport {
  totalPoints: number;
  byAssignee: Record<string, number>;
  byComponent: Record<string, number>;
  riskyItems: string[];
  recommendations: string[];
}

async function analyzeSprintPlanning(
  client: MCPClient,
  boardId: number,
  sprintId: number
): Promise<SprintPlanningReport> {
  // Get sprint issues
  const searchResult = await client.callTool({
    name: "jira_search",
    arguments: {
      jql: `sprint = ${sprintId}`,
      max_results: 100,
      fields: ["summary", "assignee", "customfield_10001", "components", "labels", "priority"]
    }
  });

  const response = JSON.parse(searchResult.content[0].text);
  const issues = response.issues;

  const report: SprintPlanningReport = {
    totalPoints: 0,
    byAssignee: {},
    byComponent: {},
    riskyItems: [],
    recommendations: []
  };

  for (const issue of issues) {
    const points = issue.fields.customfield_10001 || 0; // Story points
    const assignee = issue.fields.assignee?.displayName || "Unassigned";
    const components = issue.fields.components?.map((c: any) => c.name) || ["No Component"];

    report.totalPoints += points;
    report.byAssignee[assignee] = (report.byAssignee[assignee] || 0) + points;

    for (const component of components) {
      report.byComponent[component] = (report.byComponent[component] || 0) + points;
    }

    // Identify risks
    if (points === 0) {
      report.riskyItems.push(`${issue.key}: No story points estimated`);
    }
    if (points >= 8) {
      report.riskyItems.push(`${issue.key}: Large story (${points} points) - consider breaking down`);
    }
    if (assignee === "Unassigned") {
      report.riskyItems.push(`${issue.key}: No assignee`);
    }
  }

  // Generate recommendations
  const avgPointsPerPerson = report.totalPoints / Object.keys(report.byAssignee).length;

  for (const [assignee, points] of Object.entries(report.byAssignee)) {
    if (points > avgPointsPerPerson * 1.5) {
      report.recommendations.push(`${assignee} has ${points} points (${Math.round((points / avgPointsPerPerson - 1) * 100)}% above average) - consider rebalancing`);
    }
  }

  return report;
}
```

### Sprint Retrospective Generator

```typescript
async function generateRetroBoard(
  client: MCPClient,
  boardId: number,
  sprintId: number,
  confluenceSpaceKey: string
): Promise<string> {
  // Get completed sprint data
  const sprintResult = await client.callTool({
    name: "jira_get_sprint_report",
    arguments: {
      board_id: boardId,
      sprint_id: sprintId
    }
  });

  const sprintReport = JSON.parse(sprintResult.content[0].text);

  // Get sprint issues with details
  const issuesResult = await client.callTool({
    name: "jira_search",
    arguments: {
      jql: `sprint = ${sprintId}`,
      max_results: 100,
      fields: ["summary", "status", "resolution", "customfield_10001", "assignee"]
    }
  });

  const issues = JSON.parse(issuesResult.content[0].text).issues;

  // Calculate metrics
  const completed = issues.filter((i: any) => i.fields.resolution);
  const incomplete = issues.filter((i: any) => !i.fields.resolution);
  const completedPoints = completed.reduce((sum: number, i: any) => sum + (i.fields.customfield_10001 || 0), 0);
  const plannedPoints = issues.reduce((sum: number, i: any) => sum + (i.fields.customfield_10001 || 0), 0);

  // Create retrospective page
  const content = `
<h2>Sprint Retrospective: ${sprintReport.sprint.name}</h2>
<p><em>Generated on ${new Date().toISOString().split('T')[0]}</em></p>

<h3>Sprint Metrics</h3>
<table>
  <tr><th>Metric</th><th>Value</th></tr>
  <tr><td>Start Date</td><td>${sprintReport.sprint.startDate}</td></tr>
  <tr><td>End Date</td><td>${sprintReport.sprint.endDate}</td></tr>
  <tr><td>Issues Planned</td><td>${issues.length}</td></tr>
  <tr><td>Issues Completed</td><td>${completed.length}</td></tr>
  <tr><td>Completion Rate</td><td>${Math.round(completed.length / issues.length * 100)}%</td></tr>
  <tr><td>Points Planned</td><td>${plannedPoints}</td></tr>
  <tr><td>Points Completed</td><td>${completedPoints}</td></tr>
  <tr><td>Velocity</td><td>${completedPoints} points</td></tr>
</table>

<h3>Completed Items</h3>
<ac:structured-macro ac:name="jira">
  <ac:parameter ac:name="jqlQuery">sprint = ${sprintId} AND resolution IS NOT EMPTY</ac:parameter>
  <ac:parameter ac:name="columns">key,summary,assignee</ac:parameter>
</ac:structured-macro>

${incomplete.length > 0 ? `
<h3>Incomplete Items (Spillover)</h3>
<ac:structured-macro ac:name="warning">
  <ac:rich-text-body>
    <p>${incomplete.length} items were not completed and will spill over to the next sprint.</p>
  </ac:rich-text-body>
</ac:structured-macro>
<ac:structured-macro ac:name="jira">
  <ac:parameter ac:name="jqlQuery">sprint = ${sprintId} AND resolution IS EMPTY</ac:parameter>
  <ac:parameter ac:name="columns">key,summary,assignee,status</ac:parameter>
</ac:structured-macro>
` : ''}

<h3>Discussion Points</h3>
<ac:structured-macro ac:name="expand">
  <ac:parameter ac:name="title">What went well?</ac:parameter>
  <ac:rich-text-body>
    <ul>
      <li><em>Add team input here...</em></li>
    </ul>
  </ac:rich-text-body>
</ac:structured-macro>

<ac:structured-macro ac:name="expand">
  <ac:parameter ac:name="title">What could be improved?</ac:parameter>
  <ac:rich-text-body>
    <ul>
      <li><em>Add team input here...</em></li>
    </ul>
  </ac:rich-text-body>
</ac:structured-macro>

<ac:structured-macro ac:name="expand">
  <ac:parameter ac:name="title">Action Items</ac:parameter>
  <ac:rich-text-body>
    <ac:task-list>
      <ac:task><ac:task-body><em>Add action items here...</em></ac:task-body></ac:task>
    </ac:task-list>
  </ac:rich-text-body>
</ac:structured-macro>
`;

  const newPage = await client.callTool({
    name: "confluence_create_page",
    arguments: {
      space_key: confluenceSpaceKey,
      title: `Sprint Retro - ${sprintReport.sprint.name}`,
      body: content,
      labels: ["sprint-retro", "team-meeting"]
    }
  });

  return JSON.parse(newPage.content[0].text).id;
}
```

## Issue-Documentation Link Workflow

Bidirectional linking between code changes and documentation.

### Link PR to Documentation

```typescript
async function linkPRToDocumentation(
  client: MCPClient,
  issueKey: string,
  docPageId: string
): Promise<void> {
  // Add remote link to Jira issue
  await client.callTool({
    name: "jira_add_remote_link",
    arguments: {
      issue_key: issueKey,
      url: `https://your-site.atlassian.net/wiki/spaces/DEV/pages/${docPageId}`,
      title: "Related Documentation",
      icon_url: "https://your-site.atlassian.net/wiki/favicon.ico"
    }
  });

  // Add Jira macro to Confluence page
  const pageResult = await client.callTool({
    name: "confluence_get_page",
    arguments: {
      page_id: docPageId,
      expand: ["body.storage", "version"]
    }
  });

  const page = JSON.parse(pageResult.content[0].text);

  // Check if link already exists
  if (page.body.storage.value.includes(issueKey)) {
    return; // Already linked
  }

  const jiraLink = `
<ac:structured-macro ac:name="info">
  <ac:parameter ac:name="title">Related Issue</ac:parameter>
  <ac:rich-text-body>
    <p><ac:structured-macro ac:name="jira"><ac:parameter ac:name="key">${issueKey}</ac:parameter></ac:structured-macro></p>
  </ac:rich-text-body>
</ac:structured-macro>
`;

  await client.callTool({
    name: "confluence_update_page",
    arguments: {
      page_id: docPageId,
      title: page.title,
      body: jiraLink + page.body.storage.value,
      version_number: page.version.number + 1
    }
  });
}
```

## Utility Functions

```typescript
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withRetry<T>(
  operation: () => Promise<T>,
  maxRetries = 3,
  baseDelay = 1000
): Promise<T> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error: any) {
      if (attempt === maxRetries) throw error;

      const delay = baseDelay * Math.pow(2, attempt - 1);
      console.log(`Attempt ${attempt} failed, retrying in ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error('Unreachable');
}
```

## Related References

- `jira-queries.md` - JQL syntax for workflow queries
- `confluence-operations.md` - Page creation and formatting
- `authentication-patterns.md` - Secure API access for automated workflows

---

## Source: confluence-operations.md

# Confluence Operations

---

## CQL Fundamentals

### Basic Query Structure

```
field OPERATOR value [AND|OR field OPERATOR value]
```

### Common Operators

| Operator | Description | Example |
|----------|-------------|---------|
| `=` | Exact match | `space = "DEV"` |
| `!=` | Not equal | `type != attachment` |
| `~` | Contains | `title ~ "API"` |
| `!~` | Does not contain | `text !~ "deprecated"` |
| `>`, `<`, `>=`, `<=` | Comparison | `lastModified >= "2024-01-01"` |
| `IN` | Multiple values | `space IN ("DEV", "OPS")` |
| `NOT IN` | Exclude | `creator NOT IN ("bot")` |

### Field Reference

**Content Fields:**
```cql
type = page                        -- Pages only
type = blogpost                    -- Blog posts
type = attachment                  -- Attachments
type = comment                     -- Comments
space = "DEVDOCS"                  -- Specific space
space.type = global                -- Global spaces
space.type = personal              -- Personal spaces
```

**Search Fields:**
```cql
title ~ "architecture"             -- Title contains
text ~ "kubernetes"                -- Full text search
content ~ "deployment"             -- Content body
label = "official"                 -- Has label
label IN ("api", "reference")      -- Multiple labels
```

**Date Fields:**
```cql
created >= "2024-01-01"            -- Created after date
lastModified >= now("-30d")        -- Modified in last 30 days
created >= startOfYear()           -- Created this year
lastModified >= startOfMonth()     -- Modified this month
```

**User Fields:**
```cql
creator = currentUser()            -- Created by me
contributor = "john.doe"           -- Edited by user
mention = currentUser()            -- Mentions me
watcher = currentUser()            -- Pages I watch
favourite = currentUser()          -- My favorites
```

## Essential CQL Patterns

### Documentation Search

```cql
-- API documentation in dev space
space = "DEV" AND label = "api-docs" AND type = page

-- Recently updated architecture docs
label = "architecture" AND lastModified >= now("-7d")

-- Search for code examples
text ~ "```" AND label = "tutorial"

-- Find outdated documentation
label = "needs-review" OR lastModified <= now("-180d")

-- Meeting notes from this month
label = "meeting-notes" AND created >= startOfMonth()
```

### Space Management

```cql
-- All pages in multiple spaces
space IN ("DEV", "OPS", "PRODUCT") AND type = page

-- Personal space content
space.type = personal AND creator = currentUser()

-- Archived content
label = "archived" AND space = "LEGACY"

-- Templates
type = page AND label = "template"
```

### Content Discovery

```cql
-- Popular pages (frequently viewed)
type = page AND space = "DOCS" ORDER BY lastModified DESC

-- Draft pages
label = "draft" AND type = page

-- Pages without labels
type = page AND space = "DEV" AND label IS NULL

-- Orphan pages (no parent)
type = page AND ancestor IS NULL AND space = "DOCS"
```

## MCP Tool Calls

### Searching Content

```typescript
// Basic CQL search
const searchResult = await client.callTool({
  name: "confluence_search",
  arguments: {
    cql: 'space = "DEV" AND label = "api-docs"',
    limit: 25,
    expand: ["body.storage", "version", "ancestors"]
  }
});

// Parse results
const results = JSON.parse(searchResult.content[0].text);
for (const page of results.results) {
  console.log(`${page.title} - ${page._links.webui}`);
}

// Search with content preview
const searchWithContent = await client.callTool({
  name: "confluence_search",
  arguments: {
    cql: 'text ~ "deployment" AND space = "OPS"',
    limit: 10,
    excerpt: true
  }
});
```

### Getting Page Content

```typescript
// Get page by ID
const page = await client.callTool({
  name: "confluence_get_page",
  arguments: {
    page_id: "123456",
    expand: ["body.storage", "body.view", "version", "ancestors", "children.page"]
  }
});

// Get page by space and title
const pageByTitle = await client.callTool({
  name: "confluence_get_page_by_title",
  arguments: {
    space_key: "DEV",
    title: "API Reference"
  }
});

// Get page children
const children = await client.callTool({
  name: "confluence_get_children",
  arguments: {
    page_id: "123456",
    expand: ["page"]
  }
});
```

### Creating Pages

```typescript
// Create page with storage format (XHTML)
const newPage = await client.callTool({
  name: "confluence_create_page",
  arguments: {
    space_key: "DEV",
    title: "API Authentication Guide",
    parent_id: "123456",  // Optional parent page
    body: `
      <h2>Overview</h2>
      <p>This guide covers authentication methods for our API.</p>

      <h2>OAuth 2.0</h2>
      <p>We support OAuth 2.0 with the following grant types:</p>
      <ul>
        <li>Authorization Code</li>
        <li>Client Credentials</li>
      </ul>

      <ac:structured-macro ac:name="code">
        <ac:parameter ac:name="language">bash</ac:parameter>
        <ac:plain-text-body><![CDATA[curl -X POST https://api.example.com/oauth/token \\
  -d "grant_type=client_credentials" \\
  -d "client_id=YOUR_CLIENT_ID" \\
  -d "client_secret=YOUR_SECRET"]]></ac:plain-text-body>
      </ac:structured-macro>

      <h2>API Tokens</h2>
      <p>For simple integrations, use API tokens:</p>
      <ac:structured-macro ac:name="info">
        <ac:rich-text-body>
          <p>API tokens are tied to your user account and have the same permissions.</p>
        </ac:rich-text-body>
      </ac:structured-macro>
    `,
    labels: ["api-docs", "authentication", "official"]
  }
});

console.log(`Created page: ${newPage.content[0].text}`);
```

### Updating Pages

```typescript
// Update page content
await client.callTool({
  name: "confluence_update_page",
  arguments: {
    page_id: "123456",
    title: "API Authentication Guide (Updated)",
    body: "<h2>Updated Content</h2><p>New documentation here...</p>",
    version_number: 5,  // Current version + 1
    version_message: "Added OAuth 2.1 section"
  }
});

// Append to existing page
const currentPage = await client.callTool({
  name: "confluence_get_page",
  arguments: {
    page_id: "123456",
    expand: ["body.storage", "version"]
  }
});

const pageData = JSON.parse(currentPage.content[0].text);
const currentBody = pageData.body.storage.value;
const newSection = `
  <h2>New Section</h2>
  <p>Additional content appended to the page.</p>
`;

await client.callTool({
  name: "confluence_update_page",
  arguments: {
    page_id: "123456",
    title: pageData.title,
    body: currentBody + newSection,
    version_number: pageData.version.number + 1
  }
});
```

### Working with Comments

```typescript
// Add comment to page
await client.callTool({
  name: "confluence_add_comment",
  arguments: {
    page_id: "123456",
    body: "<p>This section needs to be updated for v2.0 changes.</p>"
  }
});

// Get page comments
const comments = await client.callTool({
  name: "confluence_get_comments",
  arguments: {
    page_id: "123456",
    expand: ["body.storage", "version"]
  }
});

// Reply to comment
await client.callTool({
  name: "confluence_add_comment",
  arguments: {
    page_id: "123456",
    parent_comment_id: "789012",
    body: "<p>Good catch! I'll update this section.</p>"
  }
});
```

### Managing Labels

```typescript
// Add labels to page
await client.callTool({
  name: "confluence_add_labels",
  arguments: {
    page_id: "123456",
    labels: ["reviewed", "q1-2024", "api-v2"]
  }
});

// Remove label
await client.callTool({
  name: "confluence_remove_label",
  arguments: {
    page_id: "123456",
    label: "draft"
  }
});

// Get page labels
const labels = await client.callTool({
  name: "confluence_get_labels",
  arguments: {
    page_id: "123456"
  }
});
```

### Space Operations

```typescript
// Get space information
const space = await client.callTool({
  name: "confluence_get_space",
  arguments: {
    space_key: "DEV",
    expand: ["description", "homepage"]
  }
});

// List all spaces
const spaces = await client.callTool({
  name: "confluence_list_spaces",
  arguments: {
    type: "global",
    limit: 100
  }
});

// Get space content
const spaceContent = await client.callTool({
  name: "confluence_get_space_content",
  arguments: {
    space_key: "DEV",
    depth: "root",  // or "all"
    expand: ["children.page"]
  }
});
```

## Storage Format Reference

### Common Macros

```xml
<!-- Code block -->
<ac:structured-macro ac:name="code">
  <ac:parameter ac:name="language">python</ac:parameter>
  <ac:parameter ac:name="title">Example</ac:parameter>
  <ac:plain-text-body><![CDATA[print("Hello, World!")]]></ac:plain-text-body>
</ac:structured-macro>

<!-- Info panel -->
<ac:structured-macro ac:name="info">
  <ac:parameter ac:name="title">Note</ac:parameter>
  <ac:rich-text-body>
    <p>Important information here.</p>
  </ac:rich-text-body>
</ac:structured-macro>

<!-- Warning panel -->
<ac:structured-macro ac:name="warning">
  <ac:rich-text-body>
    <p>Be careful with this operation!</p>
  </ac:rich-text-body>
</ac:structured-macro>

<!-- Table of contents -->
<ac:structured-macro ac:name="toc">
  <ac:parameter ac:name="maxLevel">3</ac:parameter>
</ac:structured-macro>

<!-- Jira issue link -->
<ac:structured-macro ac:name="jira">
  <ac:parameter ac:name="key">PROJ-123</ac:parameter>
</ac:structured-macro>

<!-- Jira issues table -->
<ac:structured-macro ac:name="jira">
  <ac:parameter ac:name="jqlQuery">project = PROJ AND sprint in openSprints()</ac:parameter>
  <ac:parameter ac:name="columns">key,summary,status,assignee</ac:parameter>
</ac:structured-macro>

<!-- Expand section -->
<ac:structured-macro ac:name="expand">
  <ac:parameter ac:name="title">Click to expand</ac:parameter>
  <ac:rich-text-body>
    <p>Hidden content here.</p>
  </ac:rich-text-body>
</ac:structured-macro>

<!-- Include page -->
<ac:structured-macro ac:name="include">
  <ac:parameter ac:name=""><ri:page ri:content-title="Shared Footer" /></ac:parameter>
</ac:structured-macro>
```

### Formatting Elements

```xml
<!-- Status badge -->
<ac:structured-macro ac:name="status">
  <ac:parameter ac:name="colour">Green</ac:parameter>
  <ac:parameter ac:name="title">APPROVED</ac:parameter>
</ac:structured-macro>

<!-- User mention -->
<ac:link><ri:user ri:account-id="557058:f3c7..." /></ac:link>

<!-- Page link -->
<ac:link><ri:page ri:content-title="Target Page" ri:space-key="DEV" /></ac:link>

<!-- Attachment -->
<ac:link><ri:attachment ri:filename="diagram.png" /></ac:link>

<!-- Image from attachment -->
<ac:image><ri:attachment ri:filename="screenshot.png" /></ac:image>

<!-- External image -->
<ac:image><ri:url ri:value="https://example.com/image.png" /></ac:image>
```

## Pagination Handling

```typescript
async function getAllPages(cql: string): Promise<Page[]> {
  const allPages: Page[] = [];
  let start = 0;
  const limit = 100;

  while (true) {
    const result = await client.callTool({
      name: "confluence_search",
      arguments: {
        cql,
        start,
        limit,
        expand: ["body.storage"]
      }
    });

    const response = JSON.parse(result.content[0].text);
    allPages.push(...response.results);

    if (response.results.length < limit || !response._links.next) {
      break;
    }

    start += limit;
  }

  return allPages;
}
```

## Error Handling

```typescript
async function safeConfluenceCall<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error: any) {
    const status = error.response?.status;

    switch (status) {
      case 404:
        throw new Error(`Page or space not found: ${error.message}`);
      case 403:
        throw new Error(`Permission denied. Check space permissions.`);
      case 409:
        throw new Error(`Version conflict. Page was modified. Refresh and retry.`);
      case 429:
        const retryAfter = error.response?.headers?.['retry-after'] || 60;
        throw new Error(`Rate limited. Retry after ${retryAfter} seconds.`);
      default:
        throw error;
    }
  }
}
```

## Common Anti-Patterns

**Avoid:**
```cql
-- Too broad (slow)
text ~ "the"

-- Missing quotes
space = DEV DOCS  -- WRONG
space = "DEV DOCS"  -- CORRECT

-- Invalid date format
created >= 2024-01-01  -- WRONG
created >= "2024-01-01"  -- CORRECT
```

**Best Practices:**
- Always specify space when possible for faster queries
- Use labels for categorization and filtering
- Combine text search with specific fields
- Cache frequently accessed page content
- Handle version conflicts gracefully

## Related References

- `common-workflows.md` - Documentation sync and automation
- `jira-queries.md` - Linking Confluence pages to Jira issues
- `authentication-patterns.md` - API access configuration

---

## Source: jira-queries.md

# Jira Queries and Operations

---

## JQL Fundamentals

### Basic Query Structure

```
field OPERATOR value [AND|OR field OPERATOR value]
```

### Common Operators

| Operator | Description | Example |
|----------|-------------|---------|
| `=` | Exact match | `project = "PROJ"` |
| `!=` | Not equal | `status != Done` |
| `~` | Contains (text search) | `summary ~ "login bug"` |
| `!~` | Does not contain | `description !~ "test"` |
| `>`, `<`, `>=`, `<=` | Comparison | `created >= -7d` |
| `IN` | Multiple values | `status IN (Open, "In Progress")` |
| `NOT IN` | Exclude values | `assignee NOT IN (john, jane)` |
| `IS` | Null check | `assignee IS EMPTY` |
| `IS NOT` | Not null | `resolution IS NOT EMPTY` |
| `WAS` | Historical state | `status WAS "In Progress"` |
| `CHANGED` | Field changed | `status CHANGED FROM Open` |

### Field Reference

**Standard Fields:**
```jql
project = PROJ
issuetype = Bug
status = "In Progress"
priority = High
assignee = currentUser()
reporter = "john.doe"
resolution = Unresolved
labels = backend
component = "API"
fixVersion = "2.0"
affectsVersion = "1.5"
```

**Date Fields:**
```jql
created >= -30d                    -- Last 30 days
updated >= "2024-01-01"           -- Since specific date
due <= endOfWeek()                 -- Due this week
resolved >= startOfMonth()         -- Resolved this month
```

**Text Search:**
```jql
summary ~ "authentication"         -- Summary contains
description ~ "error AND login"    -- Description search
text ~ "payment failed"            -- All text fields
comment ~ "blocked"                -- Comment contains
```

## Essential JQL Patterns

### Sprint and Backlog Queries

```jql
-- Current sprint issues
sprint in openSprints() AND project = PROJ

-- Backlog items
sprint IS EMPTY AND resolution IS EMPTY AND project = PROJ

-- Sprint completion
sprint = "Sprint 23" AND status = Done

-- Spillover from last sprint
sprint in closedSprints() AND resolution IS EMPTY

-- Ready for sprint planning
status = "Ready for Dev" AND sprint IS EMPTY
```

### Bug Tracking

```jql
-- Open bugs by priority
issuetype = Bug AND resolution IS EMPTY ORDER BY priority DESC

-- Critical production bugs
issuetype = Bug AND priority IN (Highest, High)
  AND labels = production AND resolution IS EMPTY

-- Bugs created this week
issuetype = Bug AND created >= startOfWeek()

-- Bugs without reproduction steps
issuetype = Bug AND "Reproduction Steps" IS EMPTY
  AND resolution IS EMPTY

-- Regression bugs
issuetype = Bug AND labels = regression AND fixVersion = "2.0"
```

### Team Workload

```jql
-- My open issues
assignee = currentUser() AND resolution IS EMPTY

-- Unassigned high priority
assignee IS EMPTY AND priority IN (Highest, High)
  AND resolution IS EMPTY

-- Team member workload
assignee = "jane.smith" AND sprint in openSprints()

-- Blocked issues
status = Blocked OR labels = blocked

-- Stale issues (no update in 14 days)
updated <= -14d AND resolution IS EMPTY
```

### Release Management

```jql
-- Release candidates
fixVersion = "2.0" AND status = "Ready for Release"

-- Missing fix version
resolution = Done AND fixVersion IS EMPTY AND updated >= -30d

-- Release blockers
fixVersion = "2.0" AND priority = Blocker AND resolution IS EMPTY

-- Changelog items
fixVersion = "2.0" AND resolution = Done ORDER BY issuetype
```

## MCP Tool Calls

### Searching Issues

```typescript
// Basic JQL search
const searchResult = await client.callTool({
  name: "jira_search",
  arguments: {
    jql: "project = PROJ AND sprint in openSprints()",
    max_results: 50,
    fields: ["summary", "status", "assignee", "priority"]
  }
});

// Parse response
const issues = JSON.parse(searchResult.content[0].text);
for (const issue of issues.issues) {
  console.log(`${issue.key}: ${issue.fields.summary}`);
}
```

### Getting Issue Details

```typescript
// Get single issue with all fields
const issue = await client.callTool({
  name: "jira_get_issue",
  arguments: {
    issue_key: "PROJ-123",
    expand: ["changelog", "comments", "transitions"]
  }
});

// Get issue with specific fields
const issuePartial = await client.callTool({
  name: "jira_get_issue",
  arguments: {
    issue_key: "PROJ-123",
    fields: ["summary", "description", "customfield_10001"]
  }
});
```

### Creating Issues

```typescript
// Create a bug
const newBug = await client.callTool({
  name: "jira_create_issue",
  arguments: {
    project_key: "PROJ",
    issue_type: "Bug",
    summary: "Login fails with SSO enabled",
    description: {
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Users cannot log in when SSO is enabled." }]
        },
        {
          type: "heading",
          attrs: { level: 3 },
          content: [{ type: "text", text: "Steps to Reproduce" }]
        },
        {
          type: "orderedList",
          content: [
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Enable SSO in settings" }] }] },
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Log out" }] }] },
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Attempt to log in via SSO" }] }] }
          ]
        }
      ]
    },
    priority: "High",
    labels: ["sso", "authentication", "production"],
    components: ["Authentication"],
    assignee: "jane.smith"
  }
});

console.log(`Created: ${newBug.content[0].text}`); // PROJ-456
```

### Updating Issues

```typescript
// Update issue fields
await client.callTool({
  name: "jira_update_issue",
  arguments: {
    issue_key: "PROJ-123",
    fields: {
      summary: "Updated summary",
      priority: { name: "Highest" },
      labels: ["urgent", "production"]
    }
  }
});

// Add comment
await client.callTool({
  name: "jira_add_comment",
  arguments: {
    issue_key: "PROJ-123",
    body: "Investigating this issue. Initial analysis suggests a race condition."
  }
});

// Transition issue
await client.callTool({
  name: "jira_transition_issue",
  arguments: {
    issue_key: "PROJ-123",
    transition: "In Progress"
  }
});
```

### Sprint Operations

```typescript
// Get active sprints
const sprints = await client.callTool({
  name: "jira_get_sprints",
  arguments: {
    board_id: 42,
    state: "active"
  }
});

// Move issue to sprint
await client.callTool({
  name: "jira_move_to_sprint",
  arguments: {
    sprint_id: 123,
    issue_keys: ["PROJ-100", "PROJ-101", "PROJ-102"]
  }
});

// Get sprint report
const report = await client.callTool({
  name: "jira_get_sprint_report",
  arguments: {
    board_id: 42,
    sprint_id: 123
  }
});
```

### Issue Linking

Use `jira_create_issue_link` to create dependency relationships between issues.

> **The parameter names are counterintuitive.** The naming reflects Jira's internal "inward/outward" link direction, not natural English. Verify every link call against the table below.

#### Parameter Semantics for "Blocks" Links

| Parameter | Role | Meaning |
|-----------|------|---------|
| `inward_issue_key` | **Blocker** | This issue blocks the other |
| `outward_issue_key` | **Blocked** | This issue is blocked by the other |

**Memory aid:** `inward_issue_key` = the issue receiving the inward description ("is blocked by") — but it is the *blocker*. Think: "the inward key is where the arrow points FROM."

#### Single Blocks Link

```typescript
// Make AUTH-1 block AUTH-2
// AUTH-1 will show: "blocks AUTH-2"
// AUTH-2 will show: "is blocked by AUTH-1"
await client.callTool({
  name: "jira_create_issue_link",
  arguments: {
    link_type: "Blocks",
    inward_issue_key: "AUTH-1",   // blocker
    outward_issue_key: "AUTH-2"   // blocked
  }
});
```

#### Linking a Dependency Chain

When creating a chain A → B → C (A blocks B, B blocks C):

```typescript
const chain = [
  { blocker: "AUTH-1", blocked: "AUTH-2" },
  { blocker: "AUTH-2", blocked: "AUTH-3" },
  { blocker: "AUTH-3", blocked: "AUTH-4" }
];

for (const dep of chain) {
  await client.callTool({
    name: "jira_create_issue_link",
    arguments: {
      link_type: "Blocks",
      inward_issue_key: dep.blocker,
      outward_issue_key: dep.blocked
    }
  });

  // Respect rate limits between link operations
  await delay(100);
}
```

#### Other Link Types

The same `inward`/`outward` pattern applies to all link types:

| Link Type | `inward_issue_key` shows | `outward_issue_key` shows |
|-----------|--------------------------|---------------------------|
| `Blocks` | "blocks [outward]" | "is blocked by [inward]" |
| `Duplicate` | "duplicates [outward]" | "is duplicated by [inward]" |
| `Relates` | "relates to [outward]" | "relates to [inward]" |

```typescript
// Mark PROJ-10 as a duplicate of PROJ-5
await client.callTool({
  name: "jira_create_issue_link",
  arguments: {
    link_type: "Duplicate",
    inward_issue_key: "PROJ-10",   // the duplicate
    outward_issue_key: "PROJ-5"    // the original
  }
});
```

#### Anti-Pattern: Reversed Parameters

```typescript
// WRONG — This makes AUTH-2 block AUTH-1 (backwards!)
await client.callTool({
  name: "jira_create_issue_link",
  arguments: {
    link_type: "Blocks",
    inward_issue_key: "AUTH-2",   // accidentally made AUTH-2 the blocker
    outward_issue_key: "AUTH-1"   // accidentally made AUTH-1 the blocked
  }
});
```

Always verify: after creating a link, the blocker (`inward_issue_key`) should display "blocks [outward]" in its Jira issue view.

## Pagination Handling

```typescript
async function getAllIssues(jql: string): Promise<Issue[]> {
  const allIssues: Issue[] = [];
  let startAt = 0;
  const maxResults = 100;

  while (true) {
    const result = await client.callTool({
      name: "jira_search",
      arguments: {
        jql,
        start_at: startAt,
        max_results: maxResults,
        fields: ["summary", "status", "assignee"]
      }
    });

    const response = JSON.parse(result.content[0].text);
    allIssues.push(...response.issues);

    if (startAt + response.issues.length >= response.total) {
      break;
    }

    startAt += maxResults;
  }

  return allIssues;
}
```

## Bulk Operations

```typescript
// Bulk update with JQL
async function bulkUpdateLabels(jql: string, addLabels: string[]) {
  const issues = await getAllIssues(jql);

  for (const issue of issues) {
    const existingLabels = issue.fields.labels || [];
    await client.callTool({
      name: "jira_update_issue",
      arguments: {
        issue_key: issue.key,
        fields: {
          labels: [...new Set([...existingLabels, ...addLabels])]
        }
      }
    });

    // Respect rate limits
    await delay(100);
  }
}

// Usage
await bulkUpdateLabels(
  'project = PROJ AND sprint in openSprints() AND labels = backend',
  ['q4-priority', 'needs-review']
);
```

## Error Handling

```typescript
async function safeJiraCall<T>(
  operation: () => Promise<T>,
  retries = 3
): Promise<T> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await operation();
    } catch (error: any) {
      const status = error.response?.status;

      // Don't retry client errors (except rate limits)
      if (status >= 400 && status < 500 && status !== 429) {
        throw error;
      }

      // Rate limited - wait and retry
      if (status === 429) {
        const retryAfter = parseInt(error.response?.headers?.['retry-after'] || '60');
        console.log(`Rate limited. Waiting ${retryAfter}s...`);
        await delay(retryAfter * 1000);
        continue;
      }

      // Server error - exponential backoff
      if (attempt < retries) {
        const backoff = Math.pow(2, attempt) * 1000;
        console.log(`Attempt ${attempt} failed. Retrying in ${backoff}ms...`);
        await delay(backoff);
      } else {
        throw error;
      }
    }
  }
  throw new Error('Unexpected end of retry loop');
}
```

## Common Anti-Patterns

**Avoid:**
```jql
-- Too broad (slow, may timeout)
project IS NOT EMPTY

-- Missing quotes for multi-word values
status = In Progress  -- WRONG
status = "In Progress"  -- CORRECT

-- Case sensitivity issues
assignee = John  -- May fail
assignee = "john.doe@company.com"  -- CORRECT

-- Inefficient ordering
ORDER BY created  -- Missing direction
ORDER BY created DESC  -- CORRECT
```

## Related References

- `common-workflows.md` - End-to-end workflow patterns
- `authentication-patterns.md` - Credential setup for API calls
- `confluence-operations.md` - Linking Jira issues to Confluence pages

---

## Source: mcp-server-setup.md

# MCP Server Setup

---

## Server Options Overview

### Official Atlassian MCP Server

Atlassian provides an official MCP server for cloud products:

```bash
# Install via npm
npm install -g @anthropic/mcp-atlassian

# Or use npx directly
npx @anthropic/mcp-atlassian
```

**Capabilities:**
- Jira Cloud and Confluence Cloud integration
- OAuth 2.1 authentication flow
- Read/write operations for issues and pages
- JQL and CQL query support

### Open-Source Alternatives

**mcp-atlassian (sooperset)** - Most feature-rich community option:
```bash
# Install with uv (recommended)
uv tool install mcp-atlassian

# Or with pip
pip install mcp-atlassian
```

**atlassian-mcp (xuanxt)** - TypeScript-based alternative:
```bash
npm install atlassian-mcp
```

### Comparison Matrix

| Feature | Official | sooperset | xuanxt |
|---------|----------|-----------|--------|
| Jira Cloud | Yes | Yes | Yes |
| Jira Server/DC | No | Yes | Limited |
| Confluence Cloud | Yes | Yes | Yes |
| Confluence Server/DC | No | Yes | No |
| OAuth 2.1 | Yes | Yes | No |
| API Token Auth | Yes | Yes | Yes |
| PAT (Server) | No | Yes | No |
| Rate Limiting | Built-in | Configurable | Manual |

## Claude Desktop Configuration

### Basic Setup

Edit your Claude Desktop config file:

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
**Linux:** `~/.config/claude/claude_desktop_config.json`

### Configuration Examples

**Official Server with OAuth:**
```json
{
  "mcpServers": {
    "atlassian": {
      "command": "npx",
      "args": ["@anthropic/mcp-atlassian"],
      "env": {
        "ATLASSIAN_SITE_URL": "https://your-company.atlassian.net",
        "ATLASSIAN_AUTH_TYPE": "oauth"
      }
    }
  }
}
```

**sooperset with API Token:**
```json
{
  "mcpServers": {
    "atlassian": {
      "command": "uvx",
      "args": ["mcp-atlassian"],
      "env": {
        "CONFLUENCE_URL": "https://your-company.atlassian.net/wiki",
        "CONFLUENCE_USERNAME": "your-email@company.com",
        "CONFLUENCE_API_TOKEN": "your-api-token",
        "JIRA_URL": "https://your-company.atlassian.net",
        "JIRA_USERNAME": "your-email@company.com",
        "JIRA_API_TOKEN": "your-api-token"
      }
    }
  }
}
```

**Server/Data Center with PAT:**
```json
{
  "mcpServers": {
    "atlassian": {
      "command": "uvx",
      "args": ["mcp-atlassian"],
      "env": {
        "JIRA_URL": "https://jira.internal.company.com",
        "JIRA_PERSONAL_TOKEN": "your-personal-access-token",
        "CONFLUENCE_URL": "https://confluence.internal.company.com",
        "CONFLUENCE_PERSONAL_TOKEN": "your-personal-access-token"
      }
    }
  }
}
```

## Environment Variables Reference

### Jira Configuration

| Variable | Description | Required |
|----------|-------------|----------|
| `JIRA_URL` | Base URL of Jira instance | Yes |
| `JIRA_USERNAME` | Email for cloud, username for server | Cloud only |
| `JIRA_API_TOKEN` | API token (cloud) | Cloud only |
| `JIRA_PERSONAL_TOKEN` | PAT (server/DC) | Server only |
| `JIRA_SSL_VERIFY` | Verify SSL certificates (default: true) | No |

### Confluence Configuration

| Variable | Description | Required |
|----------|-------------|----------|
| `CONFLUENCE_URL` | Base URL with /wiki suffix for cloud | Yes |
| `CONFLUENCE_USERNAME` | Email for cloud | Cloud only |
| `CONFLUENCE_API_TOKEN` | API token (cloud) | Cloud only |
| `CONFLUENCE_PERSONAL_TOKEN` | PAT (server/DC) | Server only |

### Advanced Options

| Variable | Description | Default |
|----------|-------------|---------|
| `MCP_LOG_LEVEL` | Logging verbosity (DEBUG, INFO, WARN, ERROR) | INFO |
| `MCP_TIMEOUT` | Request timeout in seconds | 30 |
| `MCP_MAX_RETRIES` | Maximum retry attempts | 3 |
| `MCP_RATE_LIMIT` | Requests per second | 10 |

## Verification and Testing

### Check Server Status

```bash
# Test official server
npx @anthropic/mcp-atlassian --version

# Test sooperset server
uvx mcp-atlassian --help

# Verify environment variables
env | grep -E "(JIRA|CONFLUENCE)_"
```

### Test Connection

Create a simple test script:

```typescript
// test-connection.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function testConnection() {
  const transport = new StdioClientTransport({
    command: "uvx",
    args: ["mcp-atlassian"],
    env: process.env,
  });

  const client = new Client(
    { name: "test-client", version: "1.0.0" },
    { capabilities: {} }
  );

  await client.connect(transport);

  // List available tools
  const tools = await client.listTools();
  console.log("Available tools:", tools.tools.map(t => t.name));

  // Test a simple read operation
  const result = await client.callTool({
    name: "jira_get_issue",
    arguments: { issue_key: "TEST-1" }
  });
  console.log("Test result:", result);

  await client.close();
}

testConnection().catch(console.error);
```

## When to Use Each Server

**Choose Official Server when:**
- Using only Atlassian Cloud products
- Need OAuth 2.1 compliance
- Require official support
- Building for enterprise deployment

**Choose sooperset when:**
- Need Server/Data Center support
- Want PAT authentication
- Require advanced filtering
- Need both Jira and Confluence

**Choose xuanxt when:**
- Want TypeScript-native implementation
- Building custom extensions
- Need minimal dependencies

## Troubleshooting

### Common Issues

**"Connection refused" error:**
```bash
# Check if server is running
ps aux | grep mcp-atlassian

# Verify URL is reachable
curl -I https://your-company.atlassian.net

# Check firewall/proxy settings
echo $HTTP_PROXY $HTTPS_PROXY
```

**"Authentication failed" error:**
```bash
# Verify API token is valid (cloud)
curl -u "email@company.com:API_TOKEN" \
  "https://your-company.atlassian.net/rest/api/3/myself"

# Verify PAT is valid (server)
curl -H "Authorization: Bearer YOUR_PAT" \
  "https://jira.internal.company.com/rest/api/2/myself"
```

**"Rate limit exceeded" error:**
```json
{
  "mcpServers": {
    "atlassian": {
      "env": {
        "MCP_RATE_LIMIT": "5"
      }
    }
  }
}
```

### Debug Mode

Enable verbose logging:

```json
{
  "mcpServers": {
    "atlassian": {
      "env": {
        "MCP_LOG_LEVEL": "DEBUG"
      }
    }
  }
}
```

## Security Best Practices

1. **Never commit credentials** - Use environment variables or secrets management
2. **Rotate API tokens regularly** - Set calendar reminders for 90-day rotation
3. **Use minimal scopes** - Request only necessary permissions
4. **Enable audit logging** - Track API usage for compliance
5. **Restrict network access** - Use allowlists where possible

## Related References

- `authentication-patterns.md` - OAuth 2.1 and API token setup details
- `jira-queries.md` - JQL syntax after connection is established
- `confluence-operations.md` - CQL and page operations

---
