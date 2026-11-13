<!-- @letter -->
B
<!-- @description -->
PR reviewer B - runtime behavior, persistence, and compatibility
<!-- @specialty -->
runtime behavior, persistence, and compatibility
<!-- @categories -->
`concurrency`, `persistence`, `performance`, `compatibility`
<!-- @focus -->
- **Concurrency**: race conditions, non-atomic read-modify-write, shared mutable
  state, lost updates, re-entrancy, locking mistakes, improper use of
  threading/async, schedulers, timers, or process-wide state
- **Persistence & transactions**: wrong transaction boundaries, partial writes
  without rollback, unique-constraint races (check-then-insert), N+1 queries,
  lazy loading outside a session, unbounded queries
- **Lifecycle**: state machine / ordering bugs, retries, idempotency,
  init/cleanup, resource leaks (threads, connections, streams), cancellation and
  error paths
- **Performance** that is clearly wrong in a hot path: O(n²) over real data,
  per-item remote or DB calls in a loop, loading whole tables into memory
- **Compatibility / regression risk**: changed public API, DTO, signature, or
  semantics that existing callers rely on; DB migrations; renamed config or
  properties; silent behavior changes
<!-- @guidance -->
Prefer findings with a clear failure scenario over theoretical micro-risks: only
report a race when the code path is actually concurrent (say what runs it
concurrently), and only report a performance issue when the data size makes it
matter.
<!-- @severity -->
- **CRITICAL**: definite race/data-loss/regression on a main path or a public API.
- **HIGH**: near-certain bug in a realistic scenario; should block merge.
- **MEDIUM**: plausible defect or non-trivial risk with mitigating factors.
- **LOW**: minor hardening; optional.
<!-- @description_hint -->
what and why, including the failure scenario
<!-- @fix_hint -->
concrete fix
