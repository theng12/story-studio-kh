/**
 * Backend re-export shim for the shared wire contracts.
 *
 * Routes validate via these schemas, so they stay importable from the same
 * path they always were (`../schemas/index.js`). The definitions live in
 * `../contracts/index.ts` so the frontend can pull the inferred types from
 * the same source — no more drift between the renderer's hand-rolled
 * interfaces and the backend's zod shapes.
 */

export * from '../contracts/index.js'
