<script lang="ts">
  import { language } from 'src/lang'
  import Button from 'src/lib/UI/GUI/Button.svelte'
  import Accordion from 'src/lib/UI/Accordion.svelte'
  import { createServerBackedSettingDraft } from 'src/ts/server/settingsOwner.svelte'

  const banCharactersetDraft = createServerBackedSettingDraft<string[]>('banCharacterset', [])

  let { noAccordion = false }: { noAccordion?: boolean } = $props()

  const characterSets = [
    'Latn',
    'Hani',
    'Arab',
    'Deva',
    'Cyrl',
    'Beng',
    'Hira',
    'Kana',
    'Telu',
    'Hang',
    'Taml',
    'Thai',
    'Gujr',
    'Knda',
    'Ethi',
    'Khmr',
    'Grek',
    'Hebr',
  ]

  const characterSetsPreview: Record<string, string> = {
    Latn: 'ABC',
    Hani: '汉漢',
    Arab: 'اعب',
    Deva: 'अआइ',
    Cyrl: 'АБВ',
    Beng: 'অআই',
    Hira: 'あい',
    Kana: 'アイ',
    Telu: 'అఆఇ',
    Hang: '가나다',
    Taml: 'அஆஇ',
    Thai: 'กขค',
    Gujr: 'અઆઇ',
    Knda: 'ಅಆಇ',
    Ethi: 'ሀሁሂ',
    Khmr: 'កខគ',
    Grek: 'ΑΒΓ',
    Hebr: 'אבג',
  }
</script>

{#snippet settingsBody()}
  {#each characterSets as set}
    <Button
      styled={banCharactersetDraft.value.includes(set) ? 'primary' : 'outlined'}
      onclick={(e) => {
        if (banCharactersetDraft.value.includes(set)) {
          banCharactersetDraft.value = banCharactersetDraft.value.filter((item) => item !== set)
        } else {
          banCharactersetDraft.value = [...banCharactersetDraft.value, set]
        }
      }}>
      {new Intl.DisplayNames([navigator.language, 'en'], { type: 'script' }).of(set)} ({characterSetsPreview[set]})
    </Button>
  {/each}
{/snippet}

{#if noAccordion}
  {@render settingsBody()}
{:else}
  <Accordion styled name={language.banCharacterset}>
    {@render settingsBody()}
  </Accordion>
{/if}
