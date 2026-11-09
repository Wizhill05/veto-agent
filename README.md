# 🛡️ The Veto Agent

> **Auth0 Challenge Project:** Focus on **Auth0 Token Vault** & **Asynchronous Authorization (CIBA)**.

The **Veto Agent** is an autonomous AI/developer task agent integrated with third-party services (GitHub REST API as the primary service, architected to easily extend to Google Calendar or Slack). It demonstrates how to safely combine **Auth0 Token Vault** for credential-free third-party access token exchange with **Out-of-Band Asynchronous Authorization (CIBA)** to guarantee that **high-impact, critical tasks are paused and must be explicitly approved or vetoed by the human operator outside the chat session**.

---

## 🌟 Key Features

1. **Auth0 Token Vault Client**:
   - Securely exchanges the agent's authentication token for a federated third-party access token (GitHub API) using RFC 8693 Token Exchange (`urn:ietf:params:oauth:grant-type:token-exchange` requesting `http://auth0.com/oauth/token-type/federated-connection-access-token`).
   - Seamless fallback to the Auth0 Management API user identity token store when configured.
   - Built-in **Mock Provider** for 100% offline development, testing, and live demos without needing live cloud credentials.

2. **Asynchronous Authorization (CIBA: Client-Initiated Backchannel Authentication)**:
   - Evaluates commands according to their risk profile (**SAFE** vs **SENSITIVE**).
   - Safe actions (e.g., `list repos`, `show open issues`) run immediately without user friction.
   - High-impact actions (e.g., `merge pr <id>`, `delete branch <name>`, `close issue <id>`) halt the agent and dispatch a backchannel authorization request via `POST /bc-authorize` with a descriptive `binding_message`.
   - Polls `POST /oauth/token` with `grant_type=urn:openid:params:grant-type:ciba`, properly handling:
     - `authorization_pending`: waits and polls at the designated interval.
     - `slow_down`: backs off polling interval dynamically.
     - `access_denied`: **Veto triggered!** Agent halts and refuses to execute the sensitive action.
     - `expired_token` / `timeout`: request expires, execution aborts safely.

3. **Offline Demo & Mock Approver Console**:
   - Ships with an embedded, zero-dependency HTTP server simulating Auth0's CIBA and Token Vault endpoints.
   - Includes a real-time web UI (`http://127.0.0.1:4321/ui`) and REST webhooks (`/approve/:id`, `/deny/:id`) allowing human operators to approve or veto pending agent actions out-of-band in real-time.

4. **Extensible Architecture**:
   - GitHub REST API implementation included out-of-the-box.
   - Clean abstractions allow adding Google Calendar (e.g. `list_events` [safe] vs `cancel_company_meeting` [sensitive]) or Slack (e.g. `read_channel` [safe] vs `delete_channel` [sensitive]) with the same Token Vault & CIBA enforcement pipeline.

---

## 🏗️ Architecture & Flow

```text
+-----------------------------------------------------------------------------------------+
|                                    USER CHAT SESSION                                    |
|                                                                                         |
|  User: "delete branch hotfix-2"                                                          |
|    |                                                                                    |
|    v                                                                                    |
|  [Command Router] ---> Classifies command as SENSITIVE (High Impact)                    |
|    |                                                                                    |
|    v                                                                                    |
|  [Auth0 Token Vault] -> Obtains third-party GitHub token securely                       |
|    |                                                                                    |
|    v                                                                                    |
|  [CIBA Client] ------> Sends POST /bc-authorize with binding_message                   |
|                        "CRITICAL APPROVAL: Agent requests to PERMANENTLY DELETE Branch" |
|    |                                                                                    |
|    +---------------------> AGENT EXECUTION PAUSED (Polling /oauth/token)                |
+-----------------------------------------------------------------------------------------+
                                         |
                       (Out-of-band push to user device)
                                         v
+-----------------------------------------------------------------------------------------+
|                             OUT-OF-BAND APPROVER CONSOLE                                |
|                       (Auth0 Guardian / Mobile App / Web UI)                            |
|                                                                                         |
|  Prompt: "CRITICAL APPROVAL: Agent requests to PERMANENTLY DELETE Branch... Approve?"   |
|                                                                                         |
|             [ APPROVE ]                                  [ VETO / DENY ]                |
+-----------------------------------------------------------------------------------------+
       |                                                          |
       | (Approved)                                               | (Denied)
       v                                                          v
  Agent resumes & executes                                   Agent aborts execution:
  DELETE /repos/.../git/refs/heads/...                       "🚫 ACTION VETOED OUT-OF-BAND"
```

---

## 🛠️ Auth0 Dashboard Setup (For Live Auth0 Mode)

To run in **live Auth0 mode** with your tenant:

### 1. Create Application for the Agent
1. In the **Auth0 Dashboard**, go to **Applications** > **Applications** > **Create Application**.
2. Name: `Veto Agent`.
3. Application Type: **Regular Web Application** (or **Machine to Machine Application**).
4. Note the **Domain**, **Client ID**, and **Client Secret**.

### 2. Configure GitHub Social Connection (for Token Vault)
1. Go to **Authentication** > **Social** > **Create Connection** > select **GitHub**.
2. Configure your GitHub OAuth App Client ID and Secret with repository scopes (`repo`, `read:user`).
3. Enable the connection for the `Veto Agent` application.
4. Under **Connections** > **GitHub**, ensure **Store Tokens to the Token Vault** (or user identity access tokens) is active.

### 3. Configure CIBA (Backchannel Authentication)
1. In the Auth0 Dashboard, navigate to **Settings** > **Advanced** (or your CIBA feature settings / Auth0 CIBA add-on).
2. Enable **Client-Initiated Backchannel Authentication (CIBA)** for your tenant.
3. Under **Applications** > **Veto Agent** > **Advanced Settings** > **Grant Types**, ensure **Backchannel Authentication (CIBA)** (`urn:openid:params:grant-type:ciba`) is checked.
4. Ensure target users have enrolled their multi-factor authenticator (e.g. **Auth0 Guardian** or custom push notification provider).

---

## ⚙️ Environment Variables

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

| Variable | Description | Default |
|---|---|---|
| `MODE` | `mock` (offline demo, no credentials needed) or `auth0` (live Auth0 tenant) | `mock` |
| `AUTH0_DOMAIN` | Your Auth0 tenant domain (e.g. `your-tenant.us.auth0.com`) | `mock.auth0.local` |
| `AUTH0_CLIENT_ID` | Auth0 Application Client ID | `mock-client-id` |
| `AUTH0_CLIENT_SECRET` | Auth0 Application Client Secret | `mock-client-secret` |
| `AUTH0_AUDIENCE` | Target API Audience identifier | |
| `AUTH0_TOKEN_VAULT_CONNECTION` | Name of the social connection in Auth0 | `github` |
| `AUTH0_USER_ID` | User ID whose vaulted GitHub token is used | `github\|mock-user-123` |
| `CIBA_USER_EMAIL` | Approver's email address used in `login_hint` | `admin@example.com` |
| `CIBA_POLL_INTERVAL_SECONDS` | Interval between polling attempts (seconds) | `2` |
| `CIBA_TIMEOUT_SECONDS` | Maximum seconds to wait before timing out | `60` |
| `GITHUB_DEFAULT_REPO` | Default GitHub repository context (`owner/repo`) | `octocat/veto-agent` |
| `MOCK_SERVER_PORT` | Port for local Mock Approver & CIBA server | `4321` |
| `MOCK_SERVER_HOST` | Host for local Mock Approver server | `127.0.0.1` |

---

## 🚀 How to Run

### Quick Start (Offline Demo Mode - No Secrets Required)

Start the interactive CLI agent in demo mode:

```bash
npm run demo
```

1. The CLI agent starts and spins up the local **Mock Approver Server** at `http://127.0.0.1:4321/ui`.
2. Open `http://127.0.0.1:4321/ui` in your browser.
3. In the CLI, try running a **safe** command:
   ```text
   veto-agent> list repos
   veto-agent> show issues
   ```
   *Notice*: The agent fetches data immediately using the Auth0 Token Vault token without triggering any approval prompt.
4. Now, attempt a **sensitive** command:
   ```text
   veto-agent> merge pr 42
   # or
   veto-agent> delete branch feature/experimental-bypass
   # or
   veto-agent> close issue 1
   ```
5. *Notice*: The agent halts! It outputs:
   ```text
   [CIBA Triggered] HIGH-IMPACT ACTION DETECTED: Mandating out-of-band authorization via CIBA...
   Binding Message: "CRITICAL APPROVAL: Agent requests to MERGE Pull Request #42 in repository 'octocat/veto-agent'. Approve?"
   [Polling CIBA] Attempt #1 (0s) - Waiting for approval at http://127.0.0.1:4321/ui ...
   ```
6. Switch to your browser tab at `http://127.0.0.1:4321/ui`:
   - Click **Approve Action** &rarr; the CLI immediately detects approval and successfully executes the merge.
   - Try another command and click **VETO (Deny)** &rarr; the CLI immediately displays:
     ```text
     🚫 ACTION VETOED OUT-OF-BAND: The user denied authorization. The command 'delete_branch' will NOT be executed.
     ```

### Running the Standalone Approver

You can also run the mock approver console separately:

```bash
npm run approver
```

### Running in Live Auth0 Mode

Ensure your `.env` contains valid Auth0 and GitHub credentials, and set `MODE=auth0`:

```bash
MODE=auth0 npm start
```

---

## 🧪 Running Tests

The test suite uses Node.js 22's built-in `node:test` runner. All tests run completely offline and verify:
- CIBA authorization initiation and binding message payload.
- Successful out-of-band user approval resolution.
- Explicit out-of-band user veto (`access_denied` error handling).
- CIBA `slow_down` polling back-off handling.
- CIBA request expiration and timeout handling.
- Token Vault RFC 8693 token exchange and token caching.
- Management API identity token retrieval fallback.
- Command routing classification (safe vs. sensitive).
- Safe command immediate execution and sensitive command blocking.

Run the test suite with:

```bash
npm test
```

---

## 📋 How this meets the challenge success criteria

| Challenge Requirement | Implementation in Veto Agent | Evidence in Code |
|---|---|---|
| **AI Agent with Third-Party Integration** | Automated CLI agent with GitHub REST API integration for managing repositories, issues, branches, and PRs (extensible to Slack/Google Calendar). | `src/github-service.js`, `src/veto-agent.js` |
| **Auth0 Token Vault for Third-Party Tokens** | Client implementing Auth0 RFC 8693 Token Exchange (`http://auth0.com/oauth/token-type/federated-connection-access-token`) and Management API identity token lookup with token caching. | `src/token-vault.js` |
| **Asynchronous Authorization (CIBA)** | Issues `POST /bc-authorize` with explicit `binding_message`, pauses agent flow, and polls `POST /oauth/token` with `urn:openid:params:grant-type:ciba`. | `src/ciba.js` |
| **Handle CIBA Flow States** | Robustly handles `authorization_pending`, `slow_down` (backoff), `access_denied` (user veto), and `expired_token`/timeout. | `src/ciba.js` (`waitForApproval`) |
| **Safe vs. Sensitive Separation** | CommandRouter classifies safe queries (`list repos`, `show issues`) to run instantly, and high-impact actions (`delete branch`, `merge pr`, `close issue`) to mandate CIBA out-of-band consent. | `src/command-router.js`, `src/veto-agent.js` |
| **Out-of-Band Approval / Veto** | User approves/vetoes outside the chat session via web console or webhook. | `src/mock-server.js` (`/ui`, `/approve/:id`, `/deny/:id`) |
| **Offline / Demo Mode** | Zero-dependency mock provider and approver server runs fully offline without requiring real credentials. | `src/mock-server.js`, `MODE=mock` |
| **Comprehensive Tests** | Unit & E2E tests covering approve, deny, and timeout paths using `node:test`. | `test/ciba.test.js`, `test/veto-agent.test.js`, `test/token-vault.test.js` |
| **Security Standards** | No hardcoded secrets; pure environment variables; strict `.gitignore` for `.env`. | `.env.example`, `.gitignore` |

---

## 📄 License

MIT
