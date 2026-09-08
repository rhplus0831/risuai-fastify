<script lang="ts">
  import type { Snippet } from 'svelte'
  import type { Database } from 'src/ts/storage/database.svelte'
  import defaultWallpaper from '../../etc/bg.jpg'

  // Presentation only: adapters supply every display value and controller surface.
  let {
    settings,
    backgroundStyle,
    showPortrait,
    content,
    background,
    navigation,
    portrait,
    classicPortrait,
    stackPortraitOnSmallScreens = false,
    minimumContentHeight = '',
  }: {
    settings: Partial<Database>
    backgroundStyle: string
    showPortrait: boolean
    content: Snippet<[string]>
    background?: Snippet
    navigation?: Snippet
    portrait?: Snippet<['waifu' | 'mobile']>
    classicPortrait?: Snippet
    stackPortraitOnSmallScreens?: boolean
    minimumContentHeight?: string
  } = $props()

  const theme = $derived(settings.theme ?? 'fastify')
  const externalStyles = $derived(
    `background: ${settings.textScreenColor ? `${settings.textScreenColor}80` : 'rgba(0,0,0,0.8)'};` +
      (settings.textBorder ? 'text-shadow: -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000;' : '') +
      (settings.textScreenRounded ? 'border-radius: 2rem; padding: 1rem;' : '') +
      (settings.textScreenBorder ? `border: 0.3rem solid ${settings.textScreenBorder};` : ''),
  )
  const wallpaper = `background: url(${defaultWallpaper})`
</script>

{#if theme === 'waifu'}
  <div
    class="grow h-full min-h-0 min-w-0 flex justify-center relative"
    style={backgroundStyle.length < 4 ? wallpaper : backgroundStyle}
    data-chat-screen-layout={theme}
    class:stack-portrait={stackPortraitOnSmallScreens}>
    {@render navigation?.()}
    {@render background?.()}
    {#if showPortrait}
      <div class="h-full mr-10 flex justify-end halfw" style:width="{42 * ((settings.waifuWidth2 ?? 100) / 100)}rem">
        {@render portrait?.('waifu')}
      </div>
    {/if}
    <div
      class="h-full min-h-0 min-w-0 w-2xl"
      style:width="{42 * ((settings.waifuWidth ?? 100) / 100)}rem"
      class:halfwp={showPortrait}>
      {@render content(`${externalStyles}backdrop-filter: blur(4px);`)}
    </div>
  </div>
{:else if theme === 'waifuMobile'}
  <div
    class="grow h-full min-h-0 min-w-0 relative"
    style={backgroundStyle.length < 4 ? wallpaper : backgroundStyle}
    data-chat-screen-layout={theme}>
    {@render navigation?.()}
    {@render background?.()}
    <div
      class="w-full absolute z-10 bottom-0 left-0"
      class:per33={showPortrait}
      class:h-full={!showPortrait}
      style:min-height={minimumContentHeight}>
      {@render content(`${externalStyles}backdrop-filter: blur(4px);`)}
    </div>
    {#if showPortrait}
      <div class="h-full w-full absolute bottom-0 left-0 max-w-full">
        {@render portrait?.('mobile')}
      </div>
    {/if}
  </div>
{:else}
  <div class="grow h-full min-h-0 min-w-0 relative justify-center flex" data-chat-screen-layout={theme}>
    {@render navigation?.()}
    {@render background?.()}
    <div
      style={backgroundStyle}
      class="h-full min-h-0 min-w-0 w-full"
      class:max-w-6xl={settings.classicMaxWidth === true}>
      {@render classicPortrait?.()}
      {@render content(backgroundStyle.length > 2 ? externalStyles : '')}
    </div>
  </div>
{/if}

<style>
  .halfw,
  .halfwp {
    max-width: calc(50% - 5rem);
  }
  .per33 {
    height: 33.333333%;
  }
  @media (max-width: 767px) {
    .stack-portrait .halfw {
      position: absolute;
      inset: 0;
      max-width: 100%;
      margin-right: 0;
      pointer-events: none;
    }
    .stack-portrait .halfwp {
      position: relative;
      max-width: 100%;
      width: 100%;
    }
  }
</style>
