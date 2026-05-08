# Custom Bug Bounty Report Template

## Title

`[TBD] <vulnerability class> in <affected asset> allows <concrete impact>`

## Summary

Finding status: `[TBD / validated / not validated]`

Affected asset: `[TBD: exact in-scope asset]`

Tested context:
- Account/context: `[TBD]`
- Role/permissions: `[TBD]`
- Timestamp range UTC: `[TBD]`

Summary:

`[TBD: what is vulnerable, the security boundary crossed, and why it matters. Do not include claims that are not backed by evidence.]`

## Scope

In-scope asset(s):
- `[TBD]`

Out-of-scope exclusions checked:
- `[TBD]`

Testing constraints:
- Non-destructive, evidence-preserving checks only.
- No brute force, credential stuffing, DoS, destructive testing, or out-of-scope testing.
- Use only researcher-owned accounts and stop if other-user data appears.

## Severity

Suggested severity: `[TBD: P1/P2/P3/P4/P5 or platform equivalent]`

Rationale:
- Exploitability: `[TBD]`
- Required privileges: `[TBD]`
- User interaction: `[TBD]`
- Data/integrity/availability impact: `[TBD]`
- Confidence: `[TBD]`

## VRT/CWE

VRT mapping:

| Field | Value |
| --- | --- |
| VRT category | `[TBD]` |
| VRT subcategory | `[TBD]` |
| VRT variant | `[TBD]` |
| VRT priority | `[TBD]` |
| Mapping rationale | `[TBD]` |

CWE mapping:

| Field | Value |
| --- | --- |
| CWE ID | `[TBD]` |
| CWE name | `[TBD]` |
| Mapping rationale | `[TBD]` |

## Steps to Reproduce

Prerequisites:
- Researcher-owned account: `[TBD or N/A]`
- Tool/browser/client version: `[TBD]`
- Required headers/cookies: `[TBD; redact secrets]`

Steps:

1. `[TBD]`
2. `[TBD]`
3. `[TBD]`

Expected result:

`[TBD]`

Actual result:

`[TBD]`

## PoC

PoC requests:

```http
<METHOD> <PATH> HTTP/2
Host: <in-scope-host>
User-Agent: <researcher user agent if required>
Cookie: <redacted researcher-owned session cookie if needed>

<body if applicable>
```

```http
HTTP/2 <status>
<relevant headers>

<redacted response body>
```

Optional PoC script:

```bash
curl -i -sS 'https://<in-scope-host>/<path>'
```

## Evidence

Evidence table:

| ID | Type | Path / snippet | UTC timestamp | Account/context | Notes |
| --- | --- | --- | --- | --- | --- |
| E-001 | Raw request/response | `[TBD]` | `[TBD]` | `[TBD]` | `[TBD]` |
| E-002 | Screenshot/video | `[TBD]` | `[TBD]` | `[TBD]` | `[TBD]` |
| E-003 | Validator notes | `[TBD]` | `[TBD]` | `[TBD]` | `[TBD]` |

Evidence requirements:
- Include exact request/response snippets.
- Include screenshots or file paths when available.
- Include timestamps and tested account/context.
- Redact secrets and personal data.

## Impact

Security impact:

`[TBD: concrete confidentiality, integrity, authentication, authorization, or availability impact.]`

Affected users/data:

`[TBD]`

Abuse scenario:

`[TBD]`

Impact limitations:

`[TBD]`

## Remediation

Recommended fix:

`[TBD: root-cause-focused remediation.]`

Verification after fix:

1. Replay the original PoC request.
2. Confirm the vulnerable behavior is blocked.
3. Confirm legitimate behavior still works.
4. Preserve patched response evidence.

## Timeline

| UTC timestamp | Event | Evidence / notes |
| --- | --- | --- |
| `[TBD]` | Vulnerability candidate discovered | `[TBD]` |
| `[TBD]` | Initial reproduction completed | `[TBD]` |
| `[TBD]` | Validator reproduction completed | `[TBD]` |
| `[TBD]` | Report submitted | `[TBD]` |
| `[TBD]` | Fix verified / retest completed | `[TBD]` |

## Limitations

- `[TBD: what was not tested and why]`
- `[TBD: uncertainty in severity, VRT/CWE mapping, or impact]`
- `[TBD: any scope boundaries relevant to triage]`
