# Debugging

Before changing code:

1. Restate the symptom and expected behavior.
2. Gather evidence from the smallest relevant path, logs, and tests.
3. Identify the most likely root cause and one way to disprove it.
4. Fix the root cause with the smallest coherent change.
5. Add or run a focused regression check.
6. Report the cause, verification, and remaining uncertainty.

Do not broaden the refactor unless the evidence requires it.
