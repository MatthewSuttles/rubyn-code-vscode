# Rubyn Code VS Code — Running Architecture Notes

Decisions that span phases live here. Read before starting each phase; update after each phase merges.

## Layout

- `src/extension.ts` — activation, lifecycle, command/provider registration.
- `src/bridge.ts`, `src/process-manager.ts` — JSON-RPC bridge to the `rubyn-code` CLI gem.
- `src/rails/` — Rails project intelligence (extension-resident). Owns the `RailsProject`, `SchemaIndex`, `ModelTableResolver` services that downstream features depend on.
- `src/completion/` — `vscode.CompletionItemProvider` implementations.
- `src/diff-provider.ts`, `src/ide-rpc-handler.ts`, `src/webview-provider.ts` — chat panel + accept/reject diff flow.
- `test/unit/`, `test/integration/`, `test/contract/` — Vitest. `test/fixtures/rails-app/` is a committed minimal Rails layout for integration + e2e tests.

## Phase 4 — Class complexity diagnostics

- Diagnostics are extension-resident. Four metric calculators live in `src/diagnostics/metrics/` (`methodCount`, `lcom4`, `fanOut`, `cyclomatic`). LCOM4 uses union-find on a method graph whose edges are (a) shared ivar references and (b) intra-class method-call references.
- Thresholds cascade `VS Code settings` → `.rubyn-code/diagnostics.yml` → built-in defaults (15 / 5 / 10 / 8). Any threshold set to `0` disables that signal; the master `rubyn-code.diagnostics.enabled` flag turns everything off.
- The yml override file is parsed by a hand-rolled `key: value` reader; reaching for `js-yaml` would be over-engineering for thresholds-only state.
- ClassIndex (sibling to ModelIndex) walks `{app,lib}/**/*.rb` with body-aware extraction — ivar refs, class constant refs, method-call candidates, and a branch-point count per method. String literals and `#` comments are scrubbed to space-runs before token extraction so quoted `Foo` constants or `&&` inside a string can't pollute the metrics.
- "Ask Rubyn to refactor" is a CodeAction that dispatches `rubyn-code.refactorFromDiagnostic`, which grounds a chat prompt in the specific signal + message that fired.
- Fourth Prism deferral. The metrics this phase needs decompose into token-level scans (branch keywords for cyclomatic, identifier-shape token extraction for ivars / refs / calls) that the line scanner already handles. Phase 5+ may force the issue if proper AST measurement becomes necessary.

## Phase 3 — Association / scope autocomplete

- Model AST parsing is **extension-resident and regex-based** — third Prism deferral. The Phase 3 design assumed Phase 2 had landed `@ruby/prism`; it hadn't, and the same WASI + ESM + webpack-bundling cost applied here. `ModelIndex` walks `app/models/**/*.rb` line-by-line, recognizes class declarations (incl. `module Foo; class Bar < ...` and `class << self`), and extracts the macros that sit at class-body top level: `has_many`, `has_one`, `belongs_to`, `has_and_belongs_to_many`, `scope`, `def`, `def self.`. Method bodies are skipped. Phase 4 may finally revisit Prism if complexity diagnostics need real cyclomatic-complexity and LCOM4 measurements that line-scans can't compute.
- `ReceiverTypeResolver` is the heart of association completion: given a cursor immediately after `.`, walk the chain leftward, balance parens around arg lists, then reduce step by step. Constants resolve through `ModelIndex.byName`; `@ivar` and locals resolve via assignment scan inside the enclosing `def`; `@ivar` in controllers falls back to the conventional `@user`-in-`UsersController` binding. **Never guess** — anything unrecognized returns `unknown`.
- `AssociationCompletionProvider` triggers on `.` and emits per-receiver-type items: class → scopes + class methods + AR class methods; instance → associations + instance methods + AR instance methods; relation → associations + scopes + AR relation methods. Returns nothing on `unknown`, so Phase 1's column completion and Phase 2's route helpers keep firing without competition. VS Code aggregates and dedupes.

## Phase 2 — Route-helper autocomplete

- Routes parsing is **regex-based with a `bin/rails routes` shell fallback**, not Prism. The original phase 2 design called for `@ruby/prism` AST parsing; we deferred Prism after weighing the WASI + ESM + webpack-bundling cost and chose regex + shell fallback instead. The DSL is structured enough that regex covers the common surface (resources, resource, namespace, scope, member/collection, http verb with `to:`/`as:`, root, draw recursion, `only:`/`except:`). The shell parser is the genuine fallback for heavily metaprogrammed routes files.
- `RoutesIndex` is lazy: constructed on first `RailsProject.routes` access, parsed on first `matching()` call. Caller must `await routes.ensureLoaded()` before reading.
- Shell-fallback heuristic: if regex parses ≥400 bytes per route on a non-trivial file, switch to `bin/rails routes --format=json`. The shell result is cached in `.rubyn-code/routes-cache.json` keyed on routes.rb mtime so the slow Rails boot is paid only when routes.rb actually changes.
- Phase 3 may revisit Prism integration when association/scope detection enters the picture; that work needs proper Ruby AST and a one-time webpack/WASI integration may finally earn its keep.

## Phase 1 — Schema-aware autocomplete

- Rails project detection is gated on `Gemfile` declaring `gem 'rails'` AND `config/application.rb` existing. `RailsProject.detect` runs before the CLI bridge so Rails-aware features survive a missing gem.
- Schema parsing is regex-based, extension-resident, lives in `src/rails/SchemaIndex.ts`. Schema.rb is machine-generated and follows a strict template — Prism would be overkill here and adds a runtime dep.
- Query-method trigger detection is regex-based — receiver-chain walk through balanced parens. Revisit in Phase 3 when Prism lands; complex chains (string literals containing parens, multi-line `do…end`) are best-effort today.
- `ModelTableResolver` is a partial port of `ActiveSupport::Inflector` — common irregulars + the `+s` / `+es` / `y → ies` suffix rules. The `f → ves` rule is intentionally absent (too many false positives like `roof → rooves`); explicit irregulars cover `leaf`, `knife`, `wolf`, etc.
- One setting gates the feature: `rubyn-code.completion.enabled` (boolean, default `true`).

## Conventions

- New Rails-aware features hang off the per-folder `RailsProject` held in `extension.ts` (`railsProjects: Map<WorkspaceFolder, RailsProject>`).
- Tests are co-located by layer: `test/unit/` for pure functions and isolated services, `test/integration/` for cross-service wiring, `test/contract/` for the JSON-RPC protocol.
- New protocol additions are additive — never break existing message shapes.
