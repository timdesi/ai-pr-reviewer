---
match: ["\\.component\\.(ts|html|scss|css)$", "\\.(service|module|directive|pipe|guard|resolver|interceptor)\\.ts$", "(^|/)angular\\.json$", "(^|/)app\\.config\\.ts$", "(^|/)app\\.routes\\.ts$", "(^|/)i18n/.+\\.json$"]
---
<!--
TEMPLATE — stack rules for Angular PRs. HTML comments like this one are
stripped before the text reaches the agents, so use them for notes to editors.

How to maintain:
- Keep only what reviewers get WRONG without help: known false positives,
  framework defaults, and team conventions that are not visible in a diff.
- Every rule should be true for all Angular repos in the project; repo-specific
  facts belong in `contexts/<PROJECT>-<repo>.md`.
- Fill in or delete the TODO sections; an empty section is noise for the model.
-->
# Angular — stack rules for AI code review

> Attached automatically when the PR changes Angular components, services,
> modules, directives, pipes, guards, interceptors, workspace config or
> `i18n/*.json` locale files.

## Known false-positive traps (verify before reporting)
- **`HttpClient` observables complete after one response.** A subscription to
  a plain `http.get/post/...` call does not leak; do not report a missing
  unsubscribe for it unless the stream is combined with a long-lived source
  (e.g. `interval`, `switchMap` from a store or form `valueChanges`).
- **The `async` pipe unsubscribes automatically** when the view is destroyed.
- **`ActivatedRoute` observables** (`params`, `queryParams`, `data`,
  `paramMap`) are cleaned up by the router with the routed component.
- **`takeUntilDestroyed()`** (Angular 16+) and `DestroyRef` are valid cleanup;
  do not ask for a manual `ngOnDestroy` + `Subject` when they are used.
- **Template bindings are sanitized**: `[innerHTML]`, `[src]`, `[href]` and
  `{{ }}` interpolation are escaped/sanitized by Angular. Only
  `DomSanitizer.bypassSecurityTrust*`, direct `ElementRef.nativeElement`
  manipulation, or `Renderer2` writes of untrusted HTML are XSS risks.

## Real problems worth reporting
- **`OnPush` components** do not re-render when an `@Input()` object is mutated
  in place; a new reference (or a signal) is required.
- Long-lived subscriptions in components/services (store selectors, form
  `valueChanges`, `interval`, websockets) without `async` pipe,
  `takeUntilDestroyed`, or explicit unsubscribe.
- Nested `subscribe()` calls instead of `switchMap`/`concatMap`/`mergeMap`
  when ordering or cancellation matters (race on fast user input).
- Secrets, tokens or environment-specific URLs hardcoded in components or
  `environment*.ts` files that ship to the browser.

## Team conventions
<!-- TODO(team): Angular major version and the APIs it implies (standalone
components vs NgModules, signals vs RxJS, control flow `@if` vs `*ngIf`). -->
<!-- TODO(team): state management (NgRx, signals store, services) and where
side effects belong. -->
<!-- TODO(team): UI component library and design-system rules (e.g. use the
shared component instead of raw HTML controls). -->

### Translations (i18n)
- Translations are produced by external translators through the shared
  translation software, **not by developers**. A developer adds a new key with
  its **English text to every locale file**; the English value in non-English
  files (`de.json`, `fr.json`, …) is the expected placeholder until the
  translation workflow replaces it.
- **Reviewers A/B/C** do **not** report "untranslated" / "English text in
  non-English locale" findings for new or changed keys — English there is the
  expected placeholder.
- **Reviewer D** (language & translation; joins only when the PR changes
  translation/content files) **may** report English values on **changed lines**
  when the PR is clearly a translation pass (most changed values are already
  localized) — that is the translator feedback the PR wants. It still does
  **not** flag English placeholders on a developer key-adding PR, and never
  flags unchanged lines.
- Do report (all reviewers) real i18n defects: a key missing from some locale
  files, a key used in code/templates that exists in no locale file, a typo or
  mismatched key name between code and locale files, or broken
  placeholders/interpolation (e.g. `{{ name }}` present in one locale and
  missing in another).

<!-- TODO(team): testing conventions (Jest/Karma, TestBed vs shallow tests,
what must be covered). -->
