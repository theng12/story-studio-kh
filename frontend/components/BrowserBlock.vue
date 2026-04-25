<template>
  <div class="browser-block" role="alertdialog" aria-modal="true" aria-labelledby="bb-title" aria-describedby="bb-body">
    <div class="card">
      <div class="icon" aria-hidden="true">⚠️</div>
      <h1 id="bb-title" class="title">Open Story Studio from the desktop app</h1>
      <p id="bb-body" class="body">
        You're viewing this page in a regular browser tab. Story Studio is a
        desktop app — running it here would let you click <strong>Generate</strong>
        and burn real provider credit without the safeguards built into the
        desktop shell.
      </p>
      <ol class="steps">
        <li>Close this browser tab.</li>
        <li>Launch <strong>Story Studio.app</strong> from your Applications folder
          (or wherever you keep it).</li>
        <li>The app will open its own window with full access to your projects.</li>
      </ol>
      <p class="footer">
        If you're a developer running <code>npm run dev</code>, this screen
        only appears in production builds — it never blocks the dev server.
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
</script>

<style scoped>
.browser-block {
  position: fixed;
  inset: 0;
  z-index: 99999;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: #0f1117;
  color: #e6e8ee;
  font-family: 'Inter', system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
  -webkit-font-smoothing: antialiased;
}
.card {
  max-width: 560px;
  width: 100%;
  padding: 36px 36px 28px;
  background: #171a23;
  border: 1px solid #262a36;
  border-radius: 14px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.45);
}
.icon {
  font-size: 40px;
  margin-bottom: 12px;
}
.title {
  margin: 0 0 12px;
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.01em;
}
.body {
  margin: 0 0 20px;
  font-size: 15px;
  line-height: 1.55;
  color: #c4c8d3;
}
.body strong {
  color: #f4f5f8;
}
.steps {
  margin: 0 0 24px;
  padding-left: 20px;
  font-size: 14px;
  line-height: 1.7;
  color: #c4c8d3;
}
.steps li + li {
  margin-top: 4px;
}
.steps strong {
  color: #f4f5f8;
}
.footer {
  margin: 0;
  padding-top: 16px;
  border-top: 1px solid #262a36;
  font-size: 12px;
  line-height: 1.5;
  color: #7a8093;
}
.footer code {
  padding: 1px 6px;
  background: #0f1117;
  border: 1px solid #262a36;
  border-radius: 4px;
  font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11.5px;
  color: #c4c8d3;
}
</style>
