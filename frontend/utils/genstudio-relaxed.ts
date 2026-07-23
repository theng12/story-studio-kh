export interface GenStudioAccessStatus {
  plan_name: string
  credit_balance: number
  relaxed_concurrency_limit: number
  relaxed_capacity_reported: boolean
  activation: 'after-credit-exhaustion'
  api_eligibility: 'verified-by-genstudio-at-submission'
  plan_portal_available: boolean
  plan_portal_url: string | null
}

export interface GenStudioUnlimitedBadge {
  label: string
  tone: 'free' | 'warning' | 'info'
  title: string
}

export function genStudioUnlimitedBadge(
  supportsUnlimited: boolean,
  access: GenStudioAccessStatus | null,
): GenStudioUnlimitedBadge | null {
  if (!supportsUnlimited) return null
  if (!access) {
    return {
      label: '∞ Check plan',
      tone: 'info',
      title: 'This model supports Unlimited Relaxed Generation. Connect GenStudio to verify whether the current plan includes it.',
    }
  }

  const plan = access.plan_name || 'the current plan'
  if (!access.relaxed_capacity_reported || access.relaxed_concurrency_limit <= 0) {
    return {
      label: '∞ Plan required',
      tone: 'warning',
      title: `This model supports Unlimited Relaxed Generation, but ${plan} reports no Relaxed capacity. Paid credits may still use it; zero-credit fallback requires an eligible plan.`,
    }
  }

  const jobs = access.relaxed_concurrency_limit === 1 ? 'job' : 'jobs'
  if (access.credit_balance <= 0) {
    return {
      label: '∞ Relaxed eligible',
      tone: 'free',
      title: `Credits are exhausted and ${plan} reports capacity for ${access.relaxed_concurrency_limit} shared Relaxed ${jobs}. GenStudio verifies model and API eligibility when the job is submitted.`,
    }
  }

  return {
    label: '∞ After credits',
    tone: 'free',
    title: `${plan} reports capacity for ${access.relaxed_concurrency_limit} shared Relaxed ${jobs}. GenStudio spends credits first; this eligible model can use Relaxed only when available credits cannot cover the request.`,
  }
}

export function genStudioPlanNotice(access: GenStudioAccessStatus | null): string {
  if (!access) {
    return 'Unlimited Relaxed Generation depends on both the selected model and an eligible GenStudio plan. Connect GenStudio to verify this account.'
  }
  const plan = access.plan_name || 'Current plan'
  const credits = `${access.credit_balance.toLocaleString()} credit${access.credit_balance === 1 ? '' : 's'}`
  if (!access.relaxed_capacity_reported || access.relaxed_concurrency_limit <= 0) {
    return `${plan} · ${credits}. Eligible models still use paid credits, but this plan does not report Unlimited Relaxed capacity.`
  }
  return `${plan} · ${credits}. Eligible models use credits first, then Relaxed capacity after credits cannot cover the request. GenStudio verifies API eligibility at submission.`
}
