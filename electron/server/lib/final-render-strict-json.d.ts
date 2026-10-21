export declare class StrictJsonError extends Error {
  constructor(message: string)
}

/** Syntax-only bounded JSON decoding; callers validate their own value schema. */
export declare function decodeStrictJson(value: string | Uint8Array, label: string): unknown
