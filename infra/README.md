# infra

AWS CDK, per CLAUDE.md §9. Intentionally empty.

§9 defers hosting until there is something worth deploying, so no CDK
dependency is installed yet — it is a large toolchain to carry for a directory
with nothing in it. Local development is Docker Postgres.

The one binding constraint on whatever gets chosen, from §9: connection
pooling must not break per-transaction `SET LOCAL`, which rules out
statement-level pooling. Session and transaction pooling are both fine —
`SET LOCAL` is scoped to the transaction either way — and transaction pooling
is the mode that *requires* it, since a plain `SET` there leaks one tenant's
context onto the next request that borrows the connection. Pooler
configuration is a correctness question here, not a performance one.
