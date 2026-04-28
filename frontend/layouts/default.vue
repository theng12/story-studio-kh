<template>
  <div class="layout">
    <a href="#main-content" class="skip-link">Skip to main content</a>
    <!-- Top bar: draggable titlebar for the hidden-inset traffic lights. -->
    <header class="top-bar">
      <div class="titlebar-drag"></div>
    </header>
    <main id="main-content" class="page-content" tabindex="-1">
      <slot />
    </main>
  </div>
</template>

<style scoped>
.layout {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
}
.top-bar {
  position: sticky;
  top: 0;
  z-index: 200;
  background: var(--bg-secondary);
  flex-shrink: 0;
}
.titlebar-drag {
  height: 38px;
  border-bottom: 1px solid var(--border);
  -webkit-app-region: drag;
}
.page-content {
  flex: 1;
  overflow-y: auto;
}
.page-content:focus { outline: none; }

.skip-link {
  position: absolute;
  top: -9999px;
  left: 0;
  z-index: 9999;
  padding: 10px 18px;
  background: var(--accent);
  color: #0f1117;
  font-weight: 600;
  text-decoration: none;
  border-radius: 0 0 var(--radius-sm) 0;
}
.skip-link:focus {
  top: 0;
  outline: 2px solid #0f1117;
  outline-offset: -4px;
}
</style>
