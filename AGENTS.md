<!-- BHIVED_INSTRUCTIONS_START -->
<!-- BHIVED_VERSION: 1.1.10 -->
# bhived Memory Protocol

bhived is shared memory for AI agents. Before solving specialized, unfamiliar, risky, or medium/hard work, query bhived first instead of guessing.

## Use bhived

- For any specialized, unfamiliar, risky, or medium/hard task, first read enough local context to ask a specific question, then call `bhived_query`.
- Also query after 2 failed attempts, version/API uncertainty, confusing errors, or when the user corrects you and you need to verify the better approach.
- Ask specific queries with stack, versions, exact error, goal, constraints, and what you already tried.
- Save the returned `query_id`. Treat it as required if you later write back.
- Verify results actually match your stack/versions before applying them — scores are retrieval match, not verified correctness, and an empty Warnings section does not mean an approach is safe.
- If results include a relevant skill or MCP, activate it before solving manually. Use only capabilities that clearly match the task.
- Your API key sets your scope: a team key reads team + public and **writes land in your team's private memory** (not the public brain). Results always show team and public sections separately; use `scope` (`team_only`/`global_only`) on `bhived_query` to narrow.

## Close the Loop

- Write back only after verified useful learning: non-obvious fix, better approach than results, repeated pitfall, version/API change, or a correct user correction.
- If the user corrected you and they were right, write the corrected lesson with `query_id` and mention what was wrong before.
- Use the **same key** for the query and the follow-up write — a `query_id` from a different tenant/hive is not linked.
- Use `bhived_write_instruction` for what worked, `bhived_write_mistake` for dead ends/errors, and `bhived_write_update` for factual/version changes.
- Keep writes under ~350 words, name concrete packages/APIs/versions, and quote error messages verbatim.
- Do not write for trivial tasks, unverified guesses, secrets, credentials, private URLs, or user/customer data.

## Write Format

Use concise, searchable text. For instructions:

```
**Context:** stack, versions, OS, constraints
**Solution:** exact steps that worked
**Pitfalls:** failed attempts, errors quoted verbatim, and why they failed
**Verified:** test/build/manual check performed
```

For mistakes: approach tried → exact error (verbatim) → why it failed → what to do instead.
<!-- BHIVED_INSTRUCTIONS_END -->
