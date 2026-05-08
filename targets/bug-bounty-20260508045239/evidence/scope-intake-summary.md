# Scope Intake Summary

Candidate: `scope-clarification-1`
Lane: `scope-intake`
Status: `blocked`

Confirmed:
- Runbook target name is `interactive-target`.
- Runbook `target.scope` is empty.
- Runbook `target.out_of_scope` is empty.
- State has no populated `target`, `scope`, `out_of_scope`, or `auth`.
- Rate limit is `conservative`.
- Destructive testing is disabled.
- No reusable auth/session material or target URL/domain/app was found in allowed checked paths.

Blocked on:
- Authorized target URL/domain/app identifier.
- In-scope and out-of-scope boundaries.
- Test account/session/API key material or a clear unauthenticated-only instruction.
- Preferred first surface to test.

Decision: blocked
