<!--
  Step 2 — Write. One request writes the batch in the channel's Formula voice, in the preset's language.
  The writing model is the preset's; the page never picks one for the customer.
-->
<template>
  <div class="sp-step">
    <StillPostsStepHead tab="write" />

    <section class="card sp-section">
      <div class="sp-two">
        <label class="sp-field sp-grow">
          <span class="sp-label">What is this batch about?</span>
          <textarea v-model="brief" class="textarea" rows="3" placeholder="Late-night thoughts about leaving a city you love"></textarea>
        </label>
        <label class="sp-field sp-narrow">
          <span class="sp-label">Posts</span>
          <input v-model.number="count" class="input" type="number" min="1" max="40">
        </label>
      </div>
      <label class="sp-field sp-model">
        <span class="sp-label">Writing model</span>
        <select v-model="preset.writing_model" class="select">
          <option :value="null">This Mac's default writing model</option>
          <option v-for="model in writingModels" :key="model.id" :value="model.id" :disabled="!model.available">
            {{ model.label }}{{ model.available ? '' : ' (unavailable)' }}
          </option>
        </select>
      </label>
      <div class="sp-row">
        <button type="button" class="btn btn-primary" :disabled="!canWrite || writing" @click="writeBatch">
          {{ writing ? 'Writing…' : `Write ${count} post${count === 1 ? '' : 's'}` }}
        </button>
        <span v-if="writeJob" class="sp-help">{{ activeJobLine(writeJob) }}</span>
      </div>
      <p v-if="writeError" class="sp-notice sp-notice-error" role="alert">{{ writeError }}</p>
    </section>
  </div>
</template>

<script setup lang="ts">
import { useStillPosts } from '../../composables/useStillPostsWorkspace'

const {
  brief, count, writing, writeError, writeJob, writeBatch, canWrite, activeJobLine, preset, writingModels,
} = useStillPosts()
</script>
