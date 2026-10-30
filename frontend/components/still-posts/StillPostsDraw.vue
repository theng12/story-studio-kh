<!--
  Step 3 — Draw. The image model is the preset's and is never chosen for the customer. The batch's
  picture jobs show here, and each post is listed with what it still needs.
-->
<template>
  <div class="sp-step">
    <StillPostsStepHead tab="draw" />

    <section class="card sp-section">
      <div class="sp-two">
        <div class="sp-field sp-grow">
          <ImageModelPicker
            v-model="imageModelChoice"
            :project-slug="slug"
            default-label="Pick an image model…"
          />
          <span class="sp-help">{{ imageModelHelp }}</span>
        </div>
      </div>

      <p
        v-if="imageModelChoice && drawingsForBatch > 0"
        class="sp-help sp-cost"
        :class="`basis-${drawCost.basis}`"
        :title="drawCost.title"
      >
        {{ CREDIT_BASIS_LABEL[drawCost.basis] }}: {{ drawCost.text }} for
        {{ drawingsForBatch }} drawing{{ drawingsForBatch === 1 ? '' : 's' }}
        ({{ preset.fresh_drawing_per_size ? 'one per ticked size' : 'one per post, fitted to each size' }}).
      </p>

      <div class="sp-row sp-draw-actions">
        <button type="button" class="btn btn-primary btn-sm" :disabled="!canDraw || drawing" @click="draw(undefined)">
          {{ drawing ? 'Drawing…' : 'Draw everything missing' }}
        </button>
        <span class="sp-help">A batch is complete only when every post has its artwork and a final in every chosen frame.</span>
      </div>
      <p v-if="drawError" class="sp-notice sp-notice-error" role="alert">{{ drawError }}</p>

      <div v-if="workspace?.batches.length" class="sp-batches">
        <div v-for="batch in workspace?.batches" :key="batch.batch_id" class="sp-batch">
          <div>
            <strong>{{ batch.batch_id }}</strong>
            <span class="sp-help">{{ batch.complete_count }}/{{ batch.total }} complete · {{ batch.aspects.join(', ') }}</span>
          </div>
          <span class="sp-pill" :class="batch.complete ? 'is-done' : 'is-in-progress'">
            {{ batch.complete ? 'Complete' : `${batch.missing.length} item(s) missing` }}
          </span>
          <button type="button" class="btn btn-sm btn-ghost" :disabled="!canDraw || drawing" @click="draw(batch.batch_id)">
            Draw this batch
          </button>
        </div>
      </div>
    </section>

    <section class="card sp-section">
      <h4 class="sp-h4">Posts <span class="sp-count">{{ posts.length }}</span></h4>
      <ul v-if="posts.length" class="sp-draw-list">
        <li v-for="post in posts" :key="post.id" class="sp-draw-row">
          <span class="sp-post-text">{{ post.panels[0]?.text }}</span>
          <span class="sp-pill" :class="postState(post.id)?.complete ? 'is-done' : 'is-in-progress'">
            {{ postState(post.id)?.complete ? 'Drawn in every frame' : (postState(post.id)?.problems[0] || 'Not drawn yet') }}
          </span>
        </li>
      </ul>
      <StillPostsPostGrid v-else />
    </section>
  </div>
</template>

<script setup lang="ts">
import { CREDIT_BASIS_LABEL } from '../../utils/genstudio-credit-cost'
import { useStillPosts } from '../../composables/useStillPostsWorkspace'

const {
  slug, workspace, preset, imageModelChoice, imageModelHelp, drawingsForBatch, drawCost, canDraw, drawing, drawError, draw,
  posts, postState,
} = useStillPosts()
</script>
