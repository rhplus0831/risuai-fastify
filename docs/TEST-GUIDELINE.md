## Test Quality Guidelines

These guidelines provide a reference for discussing newly added or modified tests. They do not, by themselves, request a test-suite audit, code changes, or test execution.

The central question is: If this test fails, does it indicate a real problem that should be fixed?

A valuable test protects meaningful behavior or a required contract, tolerates valid implementation changes, and provides enough regression-detection value to justify its maintenance and execution cost.

* Meaningful coverage: The test protects against a specific failure affecting users, correctness, data integrity, security, accessibility, or a required contract. Merely exercising code or increasing coverage is not sufficient justification.
* Behavior over implementation: Assertions focus on observable results. Private structure, arbitrary CSS classes, DOM nesting, and internal call sequences matter only when they are necessary for correctness or an explicit requirement.
* Useful layout coverage: Layout tests protect usability, including reachable controls, unobstructed content, responsive behavior, and visible focus. Exact spacing and broad visual snapshots need an explicit design requirement or a clear regression-detection purpose.
* Appropriate assertion scope: Exact matches are valuable for calculations, serialization formats, and API contracts. Broader comparisons should be justified by what actually matters, while narrower assertions should still detect forbidden or unexpected output.
* Distinct regression value: Similar tests are justified when they cover meaningfully different conditions or failure modes. Tests are redundant only when the remaining coverage detects the same failure under equivalent conditions.
* Sensitivity to real failures: A test should fail when the protected behavior breaks. Assertions that merely repeat the implementation, verify mock setup, or pass despite incorrect behavior provide weak evidence.
* Resilience to valid changes: Harmless refactoring or intentional restyling should not routinely break a test. Repeated expectation-only updates are a warning sign, though not proof that the test is unnecessary.
* Risk-aware edge cases: Rare scenarios can deserve coverage when their impact is serious or they reproduce a meaningful past bug. Rarity and frequent feature changes are not sufficient reasons to discard a test.
* Proportionate cost: Tests should be reasonably stable, focused, and easy to diagnose. Slow but valuable coverage may belong in a different execution stage rather than being removed.

When discussing a test, useful questions are:

1. What specific failure does it detect, and why does that failure matter?
2. Would it actually fail if that behavior broke?
3. Does another test already detect the same failure under equivalent conditions?
4. Could valid implementation or design changes break it unnecessarily?
5. Could a smaller or more focused assertion preserve the same protection?

Possible conclusions are keep, revise, consolidate, or remove, supported by the protected behavior and available evidence. Unclear purpose or replacement coverage should be identified as uncertainty rather than assumed to justify removal.

The goal is reliable detection of real failures with reasonable maintenance cost—not maximizing or minimizing the number of tests.
