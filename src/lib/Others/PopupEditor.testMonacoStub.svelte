<script lang="ts">
  let {
    value = $bindable(''),
    language = 'markdown',
    theme = 'vs-dark',
  }: {
    value?: string
    language?: string
    theme?: string
  } = $props()
</script>

<div data-popup-editor-monaco-stub data-language={language} data-theme={theme}>{value}</div>
