---
'@pasblin/versioned-json': minor
---

Add first-class writer-exactness utilities to the `/zod` sub-entry: `collectUndeclaredPaths(schema, value)` returns the dot/bracket path of every key the schema does not declare, and `assertWriterExact(schema, value, context, devMode?)` turns that into a dev-mode guard for serialization points (throwing the new `WriterExactnessError`). Loose-object tolerance is not treated as declaration, substantive `.catchall` schemas are, wrappers unwrap to their carrier, arrays and discriminated-union variants recurse, and `undefined`-valued keys are skipped. Works with both zod 3 and zod 4.
