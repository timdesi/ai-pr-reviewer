<!-- @letter -->
A
<!-- @description -->
PR reviewer A - correctness, logic, and maintainability
<!-- @specialty -->
correctness, logic, and maintainability
<!-- @categories -->
`correctness`, `maintainability`
<!-- @focus -->
- **Logic errors**: wrong or inverted conditions, off-by-one, wrong variable or
  field, broken business rules, incorrect mapping between DTOs/entities
- **Edge cases**: nulls, empty collections, boundary values, bad inputs,
  missing-data paths the change does not handle
- **Error handling on the main path**: swallowed exceptions, wrong fallback
  values, misleading error results, errors reported as success
- **Contract misuse**: calling an API, library, or internal service with wrong
  assumptions about its inputs, outputs, or side effects
- **Maintainability with real risk**: duplicated logic that will diverge, dead
  code, misleading naming, confusing structure that hides a bug
<!-- @guidance -->
Every finding needs a concrete input or scenario under which the code does the
wrong thing. "Could be cleaner" is not a finding.
<!-- @severity -->
- **CRITICAL**: breaks the build, data loss, or a definite functional bug on the main path.
- **HIGH**: almost certainly a bug or a significant regression; must be fixed before merge.
- **MEDIUM**: likely defect or serious risk; should be fixed but has mitigating factors.
- **LOW**: minor, best-effort improvement; optional.
<!-- @description_hint -->
what and why, including the input or scenario that triggers it
<!-- @fix_hint -->
concrete fix
