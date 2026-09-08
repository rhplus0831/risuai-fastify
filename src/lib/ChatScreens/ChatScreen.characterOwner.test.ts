import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const source = fs.readFileSync(path.resolve('src/lib/ChatScreens/ChatScreen.svelte'), 'utf8')

describe('ChatScreen selected character ownership', () => {
  it('fails closed for owner errors and retains only the idle/loading explicit-owner fallback', () => {
    expect(source).toContain("if (resourceStatus === 'ready') return owner")
    expect(source).toContain("if (resourceStatus === 'idle' || resourceStatus === 'loading') return compatibilityOwner")
    expect(source).toContain('return undefined')
    expect(source).toContain('resolveSelectedCharacterForDisplay(')
    expect(source).toContain('const status = charactersResourceState.status')
    expect(source).toContain('if ($selectedCharID < 0) return undefined')
    expect(source).toContain('selectCharacterOwner(charactersResourceState.characters, $selectedCharID)')
    expect(source).toContain("charactersResourceState.rowStatuses[character.chaId] === 'error'")
    expect(source).not.toContain('getDatabase')
  })

  it('reads display settings and selected chat validity through explicit owners', () => {
    const displaySource = fs.readFileSync(path.resolve('src/ts/gui/displaySettings.ts'), 'utf8')
    expect(source).toContain('$derived(displaySettingsForPaint())')
    expect(displaySource).toContain('settingsResourceState.groupStatuses.display')
    expect(displaySource).toContain('DISPLAY_PAINT_SETTING_KEYS')
    expect(source).toContain('getChatMetadataOwnerState(chatId)')
    expect(source).toContain('uniqueSelectedChatId(selectedCharacter)')
    expect(source).toContain('character?.chaId === characterId')
    expect(source).toContain('chat?.id === chatId')
    expect(source).not.toContain('getDatabase().theme')
    expect(source).not.toContain('getDatabase().customBackground')
    expect(source).not.toContain('getDatabase().waifuWidth')
    expect(source).not.toContain('getDatabase().classicMaxWidth')
    expect(source).not.toContain('getDatabase')
  })
})
