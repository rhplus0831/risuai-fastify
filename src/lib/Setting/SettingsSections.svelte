<script lang="ts">
  import { language } from 'src/lang'
  import type { SettingSection } from 'src/ts/setting/types'
  import Accordion from 'src/lib/UI/Accordion.svelte'
  import SettingRenderer from './SettingRenderer.svelte'

  interface Props {
    sections: SettingSection[]
  }

  let { sections }: Props = $props()

  function localizedText(key?: string): string {
    if (!key) return ''
    const value = (language as unknown as Record<string, unknown>)[key]
    return typeof value === 'string' ? value : key
  }
</script>

<div class="flex flex-col gap-4" data-settings-sections>
  {#each sections as section (section.id)}
    {@const title = localizedText(section.labelKey)}
    {#if section.collapsible}
      <div data-settings-section={section.id}>
        <Accordion
          name={section.badgeKey ? `${title} · ${localizedText(section.badgeKey)}` : title}
          styled
          className="gap-2">
          {#if section.descriptionKey}
            <p class="text-sm text-textcolor2">{localizedText(section.descriptionKey)}</p>
          {/if}
          <SettingRenderer items={section.items} />
        </Accordion>
      </div>
    {:else}
      <section
        class="rounded-lg border border-darkborderc bg-darkbg/30 p-4"
        aria-labelledby={`settings-section-${section.id}`}
        data-settings-section={section.id}>
        <div class="mb-3">
          <div class="flex flex-wrap items-center gap-2">
            <h3 id={`settings-section-${section.id}`} class="text-lg font-semibold">{title}</h3>
            {#if section.badgeKey}
              <span class="rounded-full border border-darkborderc px-2 py-0.5 text-xs text-textcolor2">
                {localizedText(section.badgeKey)}
              </span>
            {/if}
          </div>
          {#if section.descriptionKey}
            <p class="mt-1 text-sm text-textcolor2">{localizedText(section.descriptionKey)}</p>
          {/if}
        </div>
        <div class="flex flex-col">
          <SettingRenderer items={section.items} />
        </div>
      </section>
    {/if}
  {/each}
</div>
