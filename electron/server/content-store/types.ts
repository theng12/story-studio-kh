import { z } from 'zod'

const MAX_CANONICAL_BYTES = 1024 * 1024
const MAX_DETAIL_BYTES = 2 * 1024
const OPAQUE_TEXT = /^[^\u0000-\u001f\u007f]+$/

function boundedUtf8(maxBytes: number, label: string, minimumLength = 0) {
  return z.string().min(minimumLength).refine(
    value => Buffer.byteLength(value, 'utf8') <= maxBytes,
    `${label} exceeds ${maxBytes} UTF-8 bytes`,
  )
}

const OpaqueIdSchema = z.string().min(1).max(256).regex(OPAQUE_TEXT)
const SignatureSchema = z.string().min(1).max(16 * 1024).regex(OPAQUE_TEXT)
const CanonicalJsonSchema = boundedUtf8(MAX_CANONICAL_BYTES, 'canonical JSON', 2)
export const ContentStoreDetailSchema = boundedUtf8(MAX_DETAIL_BYTES, 'detail')
const IsoDateTimeSchema = z.string().datetime({ offset: true })
const CreditsSchema = z.number().int().nonnegative().safe()
const ContentOperatorDiscountSchema = z.object({
  discount_id: OpaqueIdSchema,
  version: z.number().int().positive().safe(),
  percent: z.number().int().min(1).max(99).safe(),
  starts_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  ends_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  timezone: z.literal('Asia/Phnom_Penh'),
}).strict()
const ContentBundleClosureSchema = z.object({
  position: z.number().int().nonnegative().safe(),
  product_id: OpaqueIdSchema,
  entitlement_family: OpaqueIdSchema,
  release_id: OpaqueIdSchema,
  version: OpaqueIdSchema,
  archive_sha256: z.string().regex(/^[0-9a-f]{64}$/),
}).strict()

const InsufficientCreditsRefusalSchema = z.object({
  status: z.literal(402),
  code: z.literal('insufficient_credits'),
  detail: ContentStoreDetailSchema,
  required_credits: CreditsSchema,
  available_credits: CreditsSchema,
  shortfall_credits: CreditsSchema,
}).strict().superRefine((value, context) => {
  if (value.shortfall_credits !== Math.max(0, value.required_credits - value.available_credits)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'shortfall_credits does not match the published refusal figures' })
  }
})

const ProductRefusalSchema = z.object({
  status: z.literal(404),
  code: z.enum(['product_unavailable', 'release_unavailable']),
  detail: ContentStoreDetailSchema,
}).strict()

const ConflictRefusalSchema = z.object({
  status: z.literal(409),
  code: z.enum([
    'already_owned', 'quote_rejected', 'discount_misconfigured',
    'bundle_closure_missing', 'bundle_component_unavailable',
  ]),
  detail: ContentStoreDetailSchema,
}).strict()

const SigningRefusalSchema = z.object({
  status: z.literal(503),
  code: z.literal('signing_unavailable'),
  detail: ContentStoreDetailSchema,
}).strict()

const EntitlementRefusalSchema = z.object({
  status: z.literal(403),
  code: z.literal('entitlement_revoked'),
  detail: ContentStoreDetailSchema,
}).strict()

export const CachedContentRefusalSchema = z.union([
  InsufficientCreditsRefusalSchema,
  ProductRefusalSchema,
  ConflictRefusalSchema,
  EntitlementRefusalSchema,
  SigningRefusalSchema,
])

export type CachedContentRefusal = z.infer<typeof CachedContentRefusalSchema>

export const CachedContentReceiptSchema = z.object({
  receipt_canonical_json: CanonicalJsonSchema,
  receipt_signature: SignatureSchema,
  key_id: OpaqueIdSchema,
  verification: z.literal('unverified_phase1'),
}).strict()

export type CachedContentReceipt = z.infer<typeof CachedContentReceiptSchema>

export const CachedContentPurchaseSchema = z.object({
  purchase_id: OpaqueIdSchema,
  account_id: OpaqueIdSchema,
  credits_charged: CreditsSchema,
  discount_credits: CreditsSchema,
  base_credit_price: CreditsSchema.optional(),
  component_discount_credits: CreditsSchema.optional(),
  operator_discount: ContentOperatorDiscountSchema.nullable().optional(),
  operator_discount_credits: CreditsSchema.optional(),
  balance_before: CreditsSchema,
  balance_after: CreditsSchema,
  entitlement_ids: z.array(OpaqueIdSchema).max(200),
  entitlement_families: z.array(OpaqueIdSchema).min(1).max(200),
  granted_families: z.array(OpaqueIdSchema).max(200).optional(),
  previously_owned_families: z.array(OpaqueIdSchema).max(200).optional(),
  bundle_closure: z.array(ContentBundleClosureSchema).max(200).optional(),
  product_canonical_json: CanonicalJsonSchema,
  release_canonical_json: CanonicalJsonSchema,
  ledger_event_key: OpaqueIdSchema.nullable(),
  receipt: CachedContentReceiptSchema,
  replayed: z.boolean(),
}).strict()

export type CachedContentPurchase = z.infer<typeof CachedContentPurchaseSchema>

export const CachedVerifiedContentRestoreSchema = z.object({
  account_id: OpaqueIdSchema,
  content_account_id: OpaqueIdSchema,
  genstudio_origin: z.string().url().max(2048),
  key_id: OpaqueIdSchema,
  public_key_base64: boundedUtf8(512, 'Content Store public key', 1),
  receipt_canonical_json: CanonicalJsonSchema,
  receipt_signature: SignatureSchema,
  verified_at: IsoDateTimeSchema,
}).strict()

export type CachedVerifiedContentRestore = z.infer<typeof CachedVerifiedContentRestoreSchema>

export const ContentPurchaseAttemptStatusSchema = z.enum([
  'quoted', 'submitting', 'uncertain', 'refused', 'completed',
])

export type ContentPurchaseAttemptStatus = z.infer<typeof ContentPurchaseAttemptStatusSchema>

export const ContentSubmissionOwnerSchema = z.object({
  hostname: z.string().min(1).max(255).regex(OPAQUE_TEXT),
  pid: z.number().int().positive().safe(),
  process_incarnation: z.string().min(1).max(512).regex(OPAQUE_TEXT),
  claimed_at: IsoDateTimeSchema,
  token: z.string().uuid(),
}).strict()

export const CachedContentQuoteSchema = z.object({
  quote_id: OpaqueIdSchema,
  account_id: OpaqueIdSchema,
  product_id: OpaqueIdSchema,
  release_id: OpaqueIdSchema,
  entitlement_family: OpaqueIdSchema,
  expires_at: IsoDateTimeSchema,
  quote_canonical_json: CanonicalJsonSchema,
  quote_signature: SignatureSchema,
  key_id: OpaqueIdSchema,
  idempotency_key: z.string().min(8).max(128).regex(/^story-content-[0-9a-f-]+$/),
  base_credit_price: CreditsSchema,
  discount_credits: CreditsSchema,
  entitlement_families: z.array(OpaqueIdSchema).min(1).max(200).optional(),
  bundle_closure: z.array(ContentBundleClosureSchema).max(200).optional(),
  operator_discount: ContentOperatorDiscountSchema.nullable().optional(),
  operator_discount_credits: CreditsSchema.optional(),
  quoted_credits: CreditsSchema,
  balance_before: CreditsSchema,
  balance_after: CreditsSchema,
  owned_components: z.array(OpaqueIdSchema).max(200),
  sufficient_credits: z.boolean(),
  insufficient_reason: z.literal('insufficient_credits').nullable(),
  shortfall_credits: CreditsSchema,
  status: ContentPurchaseAttemptStatusSchema,
  submission_owner: ContentSubmissionOwnerSchema.optional(),
  created_at: IsoDateTimeSchema,
  updated_at: IsoDateTimeSchema,
  last_refusal: CachedContentRefusalSchema.optional(),
  uncertain_detail: ContentStoreDetailSchema.optional(),
  completed_purchase: CachedContentPurchaseSchema.optional(),
}).strict().superRefine((value, context) => {
  if ((value.status === 'completed') !== (value.completed_purchase !== undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'completed status and completed_purchase must agree' })
  }
  if ((value.status === 'submitting') !== (value.submission_owner !== undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'submitting status and submission_owner must agree' })
  }
  if (value.status === 'refused' && !value.last_refusal) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'refused status requires last_refusal' })
  }
  if (value.status === 'uncertain' && !value.uncertain_detail) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'uncertain status requires uncertain_detail' })
  }
  if (value.sufficient_credits === (value.insufficient_reason !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'quote sufficiency fields disagree' })
  }
})

export type CachedContentQuote = z.infer<typeof CachedContentQuoteSchema>

export const ContentStoreCommerceStateSchema = z.object({
  schema_version: z.literal(1),
  attempts: z.record(CachedContentQuoteSchema).refine(value => Object.keys(value).length <= 200, 'commerce state exceeds 200 quote records'),
  verified_restore: CachedVerifiedContentRestoreSchema.optional(),
}).strict().superRefine((value, context) => {
  for (const [key, attempt] of Object.entries(value.attempts)) {
    if (key !== attempt.quote_id) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['attempts', key], message: 'attempt key must equal quote_id' })
    }
  }
})

export type ContentStoreCommerceState = z.infer<typeof ContentStoreCommerceStateSchema>

export function emptyContentStoreCommerceState(): ContentStoreCommerceState {
  return { schema_version: 1, attempts: {} }
}
