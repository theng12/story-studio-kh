<template>
  <div class="provider-accounts">
    <div class="provider-header">
      <div class="provider-title">
        <h4>{{ providerName }}</h4>
        <span v-if="accounts.length === 0" class="state-pill state-empty">No account</span>
        <span v-else class="state-pill state-set">{{ accounts.length }} account{{ accounts.length === 1 ? '' : 's' }}</span>
      </div>
      <p v-if="helpText" class="provider-help">{{ helpText }}</p>
      <p v-if="affiliateUrl" class="provider-affiliate">
        <a
          :href="affiliateUrl"
          target="_blank"
          rel="noopener noreferrer"
          class="affiliate-link"
          :title="`Open ${providerName} signup page in your browser. Signing up via this link helps support Story Studio KH.`"
        >
          Get API key →
        </a>
        <span class="affiliate-note">Signing up via this link helps support Story Studio KH.</span>
      </p>
    </div>

    <table v-if="accounts.length" class="accounts-table">
      <thead>
        <tr>
          <th class="col-default" title="Which account generators use by default">Default</th>
          <th class="col-label">Label</th>
          <th class="col-key">Key</th>
          <th class="col-actions"></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="acc in accounts" :key="acc.id" :class="{ 'is-default': acc.isDefault }">
          <td class="col-default">
            <input
              type="radio"
              class="default-radio"
              :name="`default-${providerId}`"
              :checked="acc.isDefault"
              :disabled="acc.isDefault || busyId === acc.id"
              :title="acc.isDefault ? 'Current default' : 'Make default'"
              @change="onSetDefault(acc.id)"
            />
          </td>
          <td class="col-label">
            <input
              v-if="editingId === acc.id"
              v-model="editingLabel"
              class="input input-sm"
              @keydown.enter="saveLabel(acc)"
              @keydown.escape="cancelEdit"
              @blur="saveLabel(acc)"
            />
            <template v-else>
              <button
                class="label-button"
                title="Click to rename"
                @click="startEdit(acc)"
              >
                {{ acc.label }}
              </button>
              <span
                v-if="acc.isDefault"
                class="default-pill"
                title="Generators use this account automatically"
              >Default</span>
            </template>
          </td>
          <td class="col-key">
            <code class="key-mask">{{ acc.keyMasked || '—' }}</code>
          </td>
          <td class="col-actions">
            <KeyTestPill
              v-if="testResults[acc.id]"
              :status="testResults[acc.id]!.status"
              :message="testResults[acc.id]!.message"
            />
            <button
              class="btn btn-sm btn-secondary"
              :disabled="busyId === acc.id"
              :title="`Call ${providerName} with this key to confirm it's still valid`"
              @click="onTest(acc.id)"
            >
              {{ busyAction === 'test' && busyId === acc.id ? 'Testing…' : 'Test' }}
            </button>
            <button
              class="btn btn-sm btn-danger"
              :disabled="busyId === acc.id"
              :title="`Remove this ${providerName} account. Other projects keep their own copies.`"
              @click="onRemove(acc)"
            >
              {{ busyAction === 'remove' && busyId === acc.id ? 'Removing…' : 'Remove' }}
            </button>
          </td>
        </tr>
      </tbody>
    </table>

    <div class="add-account-row">
      <input
        v-model="addLabel"
        class="input input-sm add-label"
        :placeholder="accounts.length ? 'New label (e.g. Work, Personal)' : 'Label (e.g. Default, Work)'"
        @keydown.enter="onAdd"
      />
      <ApiKeyInput
        v-model="addKey"
        :placeholder="placeholder"
        :aria-label="`New ${providerName} API key`"
      />
      <button
        class="btn btn-sm btn-primary"
        :disabled="!addLabel.trim() || !addKey.trim() || adding"
        :title="`Save a new ${providerName} account. First one added becomes the default automatically.`"
        @click="onAdd"
      >
        {{ adding ? 'Adding…' : 'Add Account' }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
interface AccountSummary {
  id: string
  label: string
  isDefault: boolean
  keyMasked: string
}

const props = defineProps<{
  slug: string
  providerId: string
  providerName: string
  accounts: AccountSummary[]
  helpText?: string
  placeholder?: string
  affiliateUrl?: string
}>()

const emit = defineEmits<{ refresh: [] }>()

const { post, patch, put, del } = useApi()
const { ask } = useConfirm()
const { success, error: showError } = useToast()

const addLabel = ref('')
const addKey = ref('')
const adding = ref(false)

const busyId = ref<string | null>(null)
const busyAction = ref<'test' | 'remove' | 'default' | 'rename' | null>(null)

// Three-state per-account test result. Mirrors the shared KeyTestPill
// component's `status` prop so the pill in the template doesn't have to
// translate anything. 'unreachable' is distinct from 'invalid' so a broken
// network / provider outage doesn't show up as "your key is wrong".
type TestStatus = 'valid' | 'invalid' | 'unreachable'
const testResults = reactive<Record<string, { status: TestStatus; message: string }>>({})

const editingId = ref<string | null>(null)
const editingLabel = ref('')

async function onAdd() {
  const label = addLabel.value.trim()
  const apiKey = addKey.value.trim()
  if (!label || !apiKey) return
  adding.value = true
  try {
    await post(`/projects/${props.slug}/settings/accounts/${props.providerId}`, { label, apiKey })
    addLabel.value = ''
    addKey.value = ''
    emit('refresh')
    success(`Added ${props.providerName} account "${label}"`)
  } catch (e: any) {
    showError(e?.data?.detail || `Failed to add ${props.providerName} account`)
  } finally {
    adding.value = false
  }
}

async function onSetDefault(accountId: string) {
  busyId.value = accountId
  busyAction.value = 'default'
  try {
    await put(`/projects/${props.slug}/settings/accounts/${props.providerId}/${accountId}/default`, {})
    emit('refresh')
  } catch (e: any) {
    showError(e?.data?.detail || 'Failed to set default account')
  } finally {
    busyId.value = null
    busyAction.value = null
  }
}

async function onTest(accountId: string) {
  busyId.value = accountId
  busyAction.value = 'test'
  try {
    // Backend `testApiKey` returns `{ valid, reachable, message }`. `valid`
    // true ⇒ pill is green; `reachable` false ⇒ pill is yellow (couldn't
    // reach provider, so not a key problem per se); otherwise red.
    const r = await post<{ valid: boolean; reachable: boolean; message?: string }>(
      `/projects/${props.slug}/test-key/${props.providerId}?account_id=${encodeURIComponent(accountId)}`,
      {},
    )
    const status: TestStatus = r.valid ? 'valid' : (r.reachable ? 'invalid' : 'unreachable')
    testResults[accountId] = {
      status,
      message: r.message || (r.valid ? 'Valid' : 'Invalid'),
    }
  } catch (e: any) {
    // The request itself failed — assume network trouble rather than a bad
    // key, so the user investigates connectivity first.
    testResults[accountId] = { status: 'unreachable', message: e?.data?.detail || 'Test failed' }
  } finally {
    busyId.value = null
    busyAction.value = null
  }
}

async function onRemove(acc: AccountSummary) {
  const remainingAccounts = props.accounts.filter(a => a.id !== acc.id)
  const promotedLabel = acc.isDefault && remainingAccounts.length > 0
    ? remainingAccounts[0]?.label
    : undefined
  const ok = await ask({
    title: `Remove ${props.providerName} account "${acc.label}"?`,
    message: promotedLabel
      ? `This project will switch its default ${props.providerName} account to "${promotedLabel}".`
      : remainingAccounts.length === 0
        ? `This project will no longer be able to run generators that use ${props.providerName}. Other projects keep their own copies.`
        : `Other ${props.providerName} accounts in this project are unaffected.`,
    confirmLabel: 'Remove account',
    danger: true,
  })
  if (!ok) return
  busyId.value = acc.id
  busyAction.value = 'remove'
  try {
    await del(`/projects/${props.slug}/settings/accounts/${props.providerId}/${acc.id}`)
    delete testResults[acc.id]
    emit('refresh')
    success(`Removed ${props.providerName} account "${acc.label}"`)
  } catch (e: any) {
    showError(e?.data?.detail || 'Failed to remove account')
  } finally {
    busyId.value = null
    busyAction.value = null
  }
}

function startEdit(acc: AccountSummary) {
  editingId.value = acc.id
  editingLabel.value = acc.label
}

function cancelEdit() {
  editingId.value = null
  editingLabel.value = ''
}

async function saveLabel(acc: AccountSummary) {
  const next = editingLabel.value.trim()
  const id = acc.id
  cancelEdit()
  if (!next || next === acc.label) return
  busyId.value = id
  busyAction.value = 'rename'
  try {
    await patch(
      `/projects/${props.slug}/settings/accounts/${props.providerId}/${id}`,
      { label: next },
    )
    emit('refresh')
  } catch (e: any) {
    showError(e?.data?.detail || 'Failed to rename account')
  } finally {
    busyId.value = null
    busyAction.value = null
  }
}
</script>

<style scoped>
.provider-accounts {
  padding: 14px 0;
  border-bottom: 1px solid var(--border);
}
.provider-accounts:last-child { border-bottom: none; }

.provider-header {
  margin-bottom: 10px;
}
.provider-title {
  display: flex;
  align-items: center;
  gap: 10px;
}
.provider-title h4 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}
.provider-help {
  margin: 4px 0 0;
  color: var(--text-secondary);
  font-size: 12px;
}
.provider-affiliate {
  margin: 4px 0 0;
  font-size: 12px;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.affiliate-link {
  color: var(--accent, #58a6ff);
  text-decoration: none;
  font-weight: 500;
}
.affiliate-link:hover { text-decoration: underline; }
.affiliate-note {
  color: var(--text-secondary);
  font-size: 11px;
  font-style: italic;
}

.state-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.4px;
}
.state-pill.state-set {
  background: var(--success-bg, rgba(46, 160, 67, 0.15));
  color: var(--success, #3fb950);
}
.state-pill.state-empty {
  background: var(--bg-tertiary);
  color: var(--text-secondary);
}

.accounts-table {
  width: 100%;
  border-collapse: collapse;
  margin-bottom: 10px;
  font-size: 13px;
}
.accounts-table th {
  text-align: left;
  font-weight: 500;
  color: var(--text-secondary);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
}
.accounts-table td {
  padding: 8px;
  border-bottom: 1px solid var(--border-subtle, var(--border));
  vertical-align: middle;
}

/* Default-account row gets a clear green treatment — subtle tinted bg +
   a left accent rail — so it's unambiguous which account generators use. */
.accounts-table tr.is-default td {
  background: rgba(46, 160, 67, 0.08);
}
.accounts-table tr.is-default td:first-child {
  box-shadow: inset 3px 0 0 var(--success, #3fb950);
}

/* Make the radio's checked fill read green in all modern browsers. */
.default-radio {
  accent-color: var(--success, #3fb950);
  cursor: pointer;
}
.default-radio:disabled {
  cursor: default;
}

.default-pill {
  display: inline-block;
  margin-left: 8px;
  padding: 1px 7px;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  border-radius: 999px;
  background: var(--success-bg, rgba(46, 160, 67, 0.15));
  color: var(--success, #3fb950);
  vertical-align: middle;
}
.col-default { width: 60px; text-align: center; }
.col-label { width: 30%; }
.col-key { font-family: 'SF Mono', Monaco, monospace; }
.col-actions { width: 1%; white-space: nowrap; }
.col-actions > * + * { margin-left: 6px; }

.key-mask {
  padding: 2px 6px;
  background: var(--bg-tertiary);
  border-radius: var(--radius-sm);
  font-size: 12px;
  letter-spacing: 0.5px;
}

.label-button {
  background: none;
  border: none;
  color: var(--text-primary);
  cursor: pointer;
  font-size: 13px;
  padding: 2px 4px;
  margin: -2px -4px;
  border-radius: var(--radius-sm);
  text-align: left;
}
.label-button:hover {
  background: var(--bg-hover);
}

.col-actions :deep(.key-test-pill) {
  margin-right: 6px;
}

.add-account-row {
  display: grid;
  grid-template-columns: minmax(140px, 1fr) minmax(260px, 2fr) auto;
  gap: 8px;
  align-items: stretch;
}
.add-account-row .add-label {
  min-width: 0;
}

@media (max-width: 720px) {
  .add-account-row {
    grid-template-columns: 1fr;
  }
}
</style>
