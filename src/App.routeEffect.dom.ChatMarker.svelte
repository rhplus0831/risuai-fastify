<script lang="ts">
  import type { AppRoute } from './ts/routerRoute'

  let { route }: { route: AppRoute } = $props()
</script>

<div data-testid="chat-screen" data-rendered-route={route.path}>Chat screen</div>
