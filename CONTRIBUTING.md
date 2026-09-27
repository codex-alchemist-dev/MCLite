# Contributing to MClite

Thanks for taking a look. MClite is a small, focused library - the
storage/atomicity core - and it's meant to stay that way, so the biggest
favor a contribution can do is keep record-kind-specific logic out of it.
Anything that needs to know what a "character" or a "pet" *is* belongs in
the consuming project, not here.

## Ground rules

- **No runtime dependencies.** Plain Node, `require()`-based. Keep it that
  way unless there's a very strong reason not to.
- **Stay generic.** If a change only makes sense for one specific game
  concept, it's a sign that logic belongs in the consuming project's own
  registration (a validator, an index projection, an integrity check),
  not hardcoded into MClite itself.
- **Test against the mock, not real Bedrock.** `test/mockOwner.js` is a
  minimal stand-in for the three dynamic-property methods MClite actually
  calls - every module should be fully testable against it, with zero
  dependency on `@minecraft/server`. If your change needs more than
  `getDynamicProperty`/`setDynamicProperty`/`getDynamicPropertyIds` to
  test, that's worth a second look.
- **`node --check` every file you touch**, and add/update a test in
  `test/mclite.test.js` for any behavior change - this project has no CI
  yet, so a PR without a way to verify it works is much harder to review.
- **Small, focused PRs** - one logical change per PR.

## Pull request process

1. Fork the repo and create a branch off `main`.
2. Make your change, following the ground rules above.
3. Run `npm test`.
4. Open a PR against `main` and fill out the template.
5. Address review feedback. A maintainer will merge once it looks good.

## Reporting bugs / requesting features

Open an issue. For a bug, include what you expected, what happened, and
how to reproduce it against the mock owner (or note if it's Bedrock-
specific behavior the mock doesn't capture). For a feature request, a
short explanation of the use case helps more than a fully-specced design.

## Code of conduct

Be respectful, assume good faith, keep disagreements about the code, not
the person.
