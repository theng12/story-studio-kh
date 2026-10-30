<!--
  The batch's posts as small cards, shared by the Draw, Review and Publish steps. A card shows the
  picture the post has, or says plainly that it is not drawn yet. It selects a post; each step then
  decides what to do with the selected one.
-->
<template>
  <div v-if="!posts.length" class="sp-empty-state">
    <p class="sp-help">No posts yet. Write a batch on the Write step — each post arrives with its quote, its scene and a caption.</p>
    <NuxtLink :to="stillPostTabRoute(slug, 'write')" class="btn btn-sm btn-secondary">Go to Write</NuxtLink>
  </div>
  <div v-else class="sp-posts">
    <button
      v-for="post in posts"
      :key="post.id"
      type="button"
      class="sp-post"
      :class="{ 'is-selected': selectedId === post.id }"
      @click="selectedId = post.id"
    >
      <img
        v-if="postImageUrl(post)"
        :src="postImageUrl(post)!"
        :alt="post.panels[0]?.text || post.id"
        class="sp-post-image"
        loading="lazy"
      >
      <span v-else class="sp-post-empty">Not drawn yet</span>
      <span class="sp-post-meta">
        <span class="sp-post-text">{{ post.panels[0]?.text }}</span>
        <span class="sp-help">{{ post.format_id }} · {{ post.option_id }} · {{ post.language }}</span>
      </span>
      <span class="sp-pill" :class="postState(post.id)?.complete ? 'is-done' : 'is-in-progress'">
        {{ postState(post.id)?.complete ? 'Complete' : 'Incomplete' }}
      </span>
    </button>
  </div>
</template>

<script setup lang="ts">
import { stillPostTabRoute } from '../../utils/still-posts-flow'
import { useStillPosts } from '../../composables/useStillPostsWorkspace'

const { slug, posts, selectedId, postImageUrl, postState } = useStillPosts()
</script>
