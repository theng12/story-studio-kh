/**
 * Request validation middleware — fail fast at the HTTP boundary.
 *
 * Every write-path route that accepts a JSON body should pipe through
 * `validate(schema)` so malformed or unexpected payloads produce a clean 400
 * before any business logic, filesystem I/O, or provider call runs. The
 * parsed, typed body replaces `req.body` so handlers can rely on shape.
 */

import { ZodError, type ZodSchema } from 'zod'

export interface ValidationDetail {
  path: string
  message: string
}

function describeIssues(err: ZodError): ValidationDetail[] {
  return err.issues.map(i => ({
    path: i.path.length ? i.path.join('.') : '(root)',
    message: i.message,
  }))
}

/**
 * Middleware: parse req.body with the given zod schema. 400 on failure.
 *
 * We intentionally don't annotate the return type as Express's `RequestHandler`.
 * Express 5 ships a stricter `ParamsDictionary` (slug is `string | string[]`
 * to model repeated params) that propagates into every downstream handler once
 * a typed middleware is chained in — producing a cascade of false positives
 * across routes whose `:slug` is always a single segment. Returning a plain
 * function lets each route's own signature drive inference as it did before.
 */
export function validateBody<T>(schema: ZodSchema<T>) {
  return (req: any, res: any, next: any) => {
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) {
      const errors = describeIssues(parsed.error)
      return res.status(400).json({
        detail: `Invalid request body: ${errors[0].path} — ${errors[0].message}`,
        errors,
      })
    }
    // Replace req.body with the parsed/coerced value so downstream code gets
    // the typed shape (e.g. defaults filled in, unknown fields stripped).
    req.body = parsed.data
    next()
  }
}
