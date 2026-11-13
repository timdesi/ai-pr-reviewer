---
match: ["\\.java$", "\\.kt$", "(^|/)pom\\.xml$", "(^|/)build\\.gradle(\\.kts)?$", "(^|/)application[^/]*\\.ya?ml$"]
---
# Java / Spring — stack rules for AI code review

> Attached automatically when the PR changes Java/Kotlin sources, Maven/Gradle
> builds or Spring `application*.yml`. Repo files (`ACME-<repo>.md`) refine it.

## Java language rules
- A constructor must invoke `super(...)`/`this(...)` as its **first statement**
  (JLS §8.8.7.1). "Move the null-guard before `super()`" is **illegal** —
  propose a static factory, dropping the redundant guard, or a null-tolerant
  base-class constructor instead.

## Known false-positive traps (verify before reporting)
- **`DateTimeFormatter.ofPattern`** defaults to the `SMART` resolver style:
  parsing `2025-02-29` with `yyyy-MM-dd` clamps to `2025-02-28` instead of
  throwing. A "parse fails / returns null / test fails" claim about such code is
  wrong unless the code sets `ResolverStyle.STRICT` (with `uuuu`).
- **JPA fetch types**: with no explicit `fetch =`, `@ManyToOne`/`@OneToOne` are
  **EAGER** and serialize safely after the transaction commits — never report
  `LazyInitializationException` for them. Only `@OneToMany`/`@ManyToMany` (or
  an explicit `FetchType.LAZY`) are lazy. Read the entity source before any
  lazy-loading claim.
- **`spring.jpa.open-in-view: false`** is not a defect and never raises a
  finding's severity.
- An EAGER `@ManyToOne` over a page of results can cause **N+1 queries**: that
  is a performance finding, at most **LOW**, pointing at the missing join fetch.
- **Feign clients** (`@FeignClient` and project-specific wrappers such as
  `@AuthorizedFeignClient`): timeouts, retries, auth headers and error decoding
  come from the referenced `configuration = ...` class and `application*.yml`.
  Read both in the checkout before claiming a missing timeout, auth or error
  handling.
