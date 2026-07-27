<template>
  <button
    type="button"
    class="page-guide-trigger"
    :title="`Open help for ${guide.title}`"
    aria-haspopup="dialog"
    @click="open = true"
  >
    <span class="page-guide-icon" aria-hidden="true">?</span>
    <span class="page-guide-label">Page guide</span>
  </button>

  <Modal
    :visible="open"
    size="xl"
    labelledby="feature-guide-title"
    dialog-class="feature-guide-dialog"
    @close="open = false"
  >
    <header class="guide-header">
      <div>
        <span class="guide-eyebrow">Help and feature guide</span>
        <h2 id="feature-guide-title">{{ guide.title }}</h2>
        <p>{{ guide.summary }}</p>
      </div>
      <button type="button" class="guide-close" aria-label="Close page guide" @click="open = false">x</button>
    </header>

    <label class="guide-search">
      <span>Find a feature on this page</span>
      <input v-model.trim="query" class="input" type="search" placeholder="Search purpose, effect, or usage..." />
    </label>

    <section v-if="!query" class="guide-workflow" aria-labelledby="guide-workflow-title">
      <div class="guide-section-heading">
        <span class="guide-number">01</span>
        <div>
          <span class="guide-kicker">Recommended flow</span>
          <h3 id="guide-workflow-title">How to use this workspace</h3>
        </div>
      </div>
      <ol>
        <li v-for="step in guide.workflow" :key="step">{{ step }}</li>
      </ol>
    </section>

    <section class="guide-topics" aria-labelledby="guide-topics-title">
      <div class="guide-section-heading">
        <span class="guide-number">02</span>
        <div>
          <span class="guide-kicker">Feature details</span>
          <h3 id="guide-topics-title">{{ query ? `${filteredTopics.length} matching feature${filteredTopics.length === 1 ? '' : 's'}` : 'What each feature does' }}</h3>
        </div>
      </div>
      <div v-if="filteredTopics.length" class="guide-topic-grid">
        <article v-for="topic in filteredTopics" :key="topic.title" class="guide-topic">
          <h4>{{ topic.title }}</h4>
          <p>{{ topic.purpose }}</p>
          <dl v-if="topic.useWhen || topic.effect">
            <template v-if="topic.useWhen">
              <dt>Use it when</dt>
              <dd>{{ topic.useWhen }}</dd>
            </template>
            <template v-if="topic.effect">
              <dt>What changes</dt>
              <dd>{{ topic.effect }}</dd>
            </template>
          </dl>
        </article>
      </div>
      <div v-else class="guide-empty">No feature on this page matches "{{ query }}".</div>
    </section>

    <section v-if="!query" class="guide-tips" aria-labelledby="guide-tips-title">
      <div class="guide-section-heading">
        <span class="guide-number">03</span>
        <div>
          <span class="guide-kicker">Practical guidance</span>
          <h3 id="guide-tips-title">Good defaults and safeguards</h3>
        </div>
      </div>
      <ul>
        <li v-for="tip in guide.tips" :key="tip">{{ tip }}</li>
      </ul>
    </section>
  </Modal>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'

const route = useRoute()
const { guide } = useFeatureGuide()
const open = ref(false)
const query = ref('')

const filteredTopics = computed(() => {
  const needle = query.value.toLocaleLowerCase()
  if (!needle) return guide.value.topics
  return guide.value.topics.filter((topic) =>
    [topic.title, topic.purpose, topic.useWhen, topic.effect]
      .filter(Boolean)
      .some((value) => String(value).toLocaleLowerCase().includes(needle)),
  )
})

watch(() => route.fullPath, () => {
  open.value = false
  query.value = ''
})
</script>

<style scoped>
.page-guide-trigger {
  display: inline-flex;
  align-items: center;
  gap: .45rem;
  min-height: 30px;
  padding: .3rem .65rem;
  border: 1px solid color-mix(in srgb, var(--accent) 45%, var(--border));
  border-radius: 999px;
  background: color-mix(in srgb, var(--accent) 8%, var(--bg-secondary));
  color: var(--text-primary);
  font-size: var(--font-sm);
  font-weight: 700;
  cursor: pointer;
  -webkit-app-region: no-drag;
}
.page-guide-trigger:hover,
.page-guide-trigger:focus-visible {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 15%, var(--bg-secondary));
  outline: none;
}
.page-guide-icon {
  display: inline-grid;
  place-items: center;
  width: 1.15rem;
  height: 1.15rem;
  border-radius: 50%;
  background: var(--accent);
  color: #16130d;
  font-size: .72rem;
  line-height: 1;
}
.guide-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1.5rem;
  padding-bottom: 1.2rem;
  border-bottom: 1px solid var(--border);
}
.guide-header h2 {
  margin: .18rem 0 .4rem;
  color: var(--text-primary);
  font-family: var(--font-display);
  font-size: clamp(1.7rem, 3vw, 2.4rem);
}
.guide-header p {
  max-width: 48rem;
  margin: 0;
  color: var(--text-secondary);
  font-size: var(--font-md);
  line-height: 1.55;
}
.guide-eyebrow,
.guide-kicker {
  color: var(--accent);
  font-size: var(--font-xs);
  font-weight: 800;
  letter-spacing: .12em;
  text-transform: uppercase;
}
.guide-close {
  display: grid;
  place-items: center;
  width: 2rem;
  height: 2rem;
  border: 1px solid var(--border);
  border-radius: 50%;
  background: var(--bg-input);
  color: var(--text-secondary);
  font-size: 1rem;
  cursor: pointer;
}
.guide-search {
  display: grid;
  gap: .42rem;
  margin: 1rem 0;
  color: var(--text-secondary);
  font-size: var(--font-sm);
  font-weight: 700;
}
.guide-workflow,
.guide-topics,
.guide-tips {
  padding: 1rem 0;
}
.guide-topics {
  border-top: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
}
.guide-section-heading {
  display: flex;
  align-items: center;
  gap: .72rem;
  margin-bottom: .85rem;
}
.guide-section-heading h3 {
  margin: .08rem 0 0;
  color: var(--text-primary);
  font-size: var(--font-lg);
}
.guide-number {
  display: grid;
  place-items: center;
  width: 2rem;
  height: 2rem;
  border-radius: .55rem;
  background: color-mix(in srgb, var(--accent) 15%, var(--bg-input));
  color: var(--accent);
  font: 800 var(--font-xs)/1 var(--font-mono);
}
.guide-workflow ol {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: .65rem;
  margin: 0;
  padding: 0;
  list-style: none;
  counter-reset: workflow;
}
.guide-workflow li {
  counter-increment: workflow;
  position: relative;
  min-height: 4.5rem;
  padding: .85rem .85rem .85rem 2.75rem;
  border: 1px solid var(--border);
  border-radius: .65rem;
  background: var(--bg-input);
  color: var(--text-secondary);
  line-height: 1.45;
}
.guide-workflow li::before {
  content: counter(workflow);
  position: absolute;
  top: .78rem;
  left: .8rem;
  display: grid;
  place-items: center;
  width: 1.35rem;
  height: 1.35rem;
  border-radius: 50%;
  background: var(--accent);
  color: #16130d;
  font-size: .7rem;
  font-weight: 800;
}
.guide-topic-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: .65rem;
}
.guide-topic {
  min-width: 0;
  padding: .9rem;
  border: 1px solid var(--border);
  border-radius: .65rem;
  background: color-mix(in srgb, var(--bg-input) 82%, transparent);
}
.guide-topic h4 {
  margin: 0 0 .35rem;
  color: var(--text-primary);
  font-size: var(--font-md);
}
.guide-topic p {
  margin: 0;
  color: var(--text-secondary);
  font-size: var(--font-sm);
  line-height: 1.5;
}
.guide-topic dl {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: .28rem .55rem;
  margin: .65rem 0 0;
  padding-top: .55rem;
  border-top: 1px solid var(--border);
  font-size: var(--font-xs);
}
.guide-topic dt {
  color: var(--accent);
  font-weight: 800;
}
.guide-topic dd {
  margin: 0;
  color: var(--text-muted);
}
.guide-tips ul {
  display: grid;
  gap: .48rem;
  margin: 0;
  padding-left: 1.2rem;
  color: var(--text-secondary);
  line-height: 1.5;
}
.guide-tips li::marker {
  color: var(--accent);
}
.guide-empty {
  padding: 1.2rem;
  border: 1px dashed var(--border);
  border-radius: .65rem;
  color: var(--text-muted);
  text-align: center;
}
@media (max-width: 760px) {
  .page-guide-label { display: none; }
  .page-guide-trigger { padding: .35rem; }
  .guide-workflow ol,
  .guide-topic-grid { grid-template-columns: 1fr; }
}
</style>
