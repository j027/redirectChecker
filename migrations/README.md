# Migrations

Add one SQL file per schema change, for example:

```
migrations/2026-11-12-add-example-column.sql
```

Workflow:

1. Add the delta SQL file here.
2. Apply it to existing databases with `yarn migrate:dev`.
3. Update `src/schema.sql` to the final state.
4. Commit both files.

Fresh installs use `yarn init-db:dev`; `src/schema.sql` is the current baseline. Do not run `init-db` against an existing database.
