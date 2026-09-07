import { replaceResourceDatabase } from 'src/ts/server/resourceState.svelte'
import { selectedCharID } from 'src/ts/stores.svelte'
import { demoteClientSession } from 'src/ts/clientSession'
import {
  beginWriterDraftCaptureTest,
  endWriterDraftCaptureTest,
  capturedWriterDrafts,
} from 'src/ts/__tests__/writerDraftCapture'
import { mount, tick, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { language } from 'src/lang'
import TagManagerModalTestHost from './tag-manager-modal.testHost.svelte'

type MountedComponent = Parameters<typeof unmount>[0]

let component: MountedComponent | undefined
let target: HTMLElement

beforeEach(() => {
  target = document.createElement('div')
  document.body.appendChild(target)
})

afterEach(() => {
  if (component) {
    unmount(component)
    component = undefined
  }
  target.remove()
})

describe('Hypa V3 tag manager', () => {
  it('does not rename a tag to an existing tag', async () => {
    const onSummaryChanged = vi.fn()
    component = mount(TagManagerModalTestHost, {
      target,
      props: {
        onSummaryChanged,
      },
    })
    await tick()

    const editButtons = target.querySelectorAll<HTMLButtonElement>(
      `button[aria-label="${language.hypaV3Modal.editTagAction}"]`,
    )
    editButtons[1]?.click()
    await tick()

    const input = target.querySelector<HTMLInputElement>(`input[aria-label="${language.hypaV3Modal.tagNameLabel}"]`)
    if (!input) throw new Error('Tag edit input not found')
    input.value = ' foo '
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
    target.querySelector<HTMLButtonElement>(`button[aria-label="${language.hypaV3Modal.saveTagAction}"]`)?.click()
    await tick()

    expect((component as unknown as { getTags: () => string[] }).getTags()).toEqual(['foo', 'bar'])
    expect(onSummaryChanged).not.toHaveBeenCalled()
    expect(target.querySelector(`input[aria-label="${language.hypaV3Modal.tagNameLabel}"]`)).not.toBeNull()
  })
})

it('captures a tag edit before it is confirmed', async () => {
  await beginWriterDraftCaptureTest()
  replaceResourceDatabase({
    currentChar: 0,
    characters: [{ chaId: 'memory-owner', chats: [{ id: 'memory-chat', message: [] }], chatPage: 0 }],
  } as never)
  selectedCharID.set(0)
  try {
    component = mount(TagManagerModalTestHost, { target })
    await tick()
    const input = target.querySelector<HTMLInputElement>(`input[aria-label="${language.hypaV3Modal.newTagName}"]`)!
    input.value = 'unsubmitted tag'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    demoteClientSession()
    expect(capturedWriterDrafts().find((draft) => draft.key.startsWith('memory-tag:memory-chat:'))?.data).toMatchObject(
      { tag: 'unsubmitted tag' },
    )
    expect((component as unknown as { getTags: () => string[] }).getTags()).toEqual(['foo', 'bar'])
  } finally {
    if (component) {
      await unmount(component)
      component = undefined
    }
    selectedCharID.set(-1)
    await endWriterDraftCaptureTest()
  }
})

it('captures an unconfirmed category name without applying it', async () => {
  await beginWriterDraftCaptureTest()
  replaceResourceDatabase({
    currentChar: 0,
    characters: [{ chaId: 'memory-owner', chats: [{ id: 'memory-chat', message: [] }], chatPage: 0 }],
  } as never)
  selectedCharID.set(0)
  try {
    component = mount(TagManagerModalTestHost, { target, props: { category: true } })
    await tick()
    const input = target.querySelector<HTMLInputElement>(`input[aria-label="${language.hypaV3Modal.categoryName}"]`)!
    input.value = 'Unsubmitted category'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    demoteClientSession()
    expect(
      capturedWriterDrafts().find((draft) => draft.key === 'memory-category:memory-chat:story')?.data,
    ).toMatchObject({ category: { name: 'Unsubmitted category' } })
  } finally {
    if (component) {
      await unmount(component)
      component = undefined
    }
    selectedCharID.set(-1)
    await endWriterDraftCaptureTest()
  }
})
