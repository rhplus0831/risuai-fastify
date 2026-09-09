/**
 * Language Settings Data
 *
 * Data-driven definition for LanguageSettings page.
 * Uses `.svelte.ts` extension to support reactive `langState` via Svelte 5 runes.
 */

import type { SettingItem } from './types'
import { changeLanguage, language } from 'src/lang'
import { alertNormal, alertConfirm, alertError, alertWait } from '../alert'
import { downloadFile } from '../globalApi.svelte'
import { selectFileByDom } from '../filePicker'
import { exportLLMCacheAsJSON, importLLMCacheFromJSON, clearLLMCache } from '../translator/translator'

export const langState = $state({ changed: false })

export const languageSettingsItems: SettingItem[] = [
  {
    id: 'lang.header',
    type: 'header',
    labelKey: 'language',
    options: { level: 'h2' },
  },

  // UI Language
  {
    id: 'lang.uiLanguage',
    type: 'select',
    labelKey: 'UiLanguage',
    bindKey: 'language',
    classes: 'mt-4',
    options: {
      selectFallbackValue: 'en',
      selectOptions: [
        { value: 'de', label: 'Deutsch' },
        { value: 'en', label: 'English' },
        { value: 'es', label: 'Español' },
        { value: 'ko', label: '한국어' },
        { value: 'cn', label: '中文' },
        { value: 'zh-Hant', label: '中文(繁體)' },
        { value: 'vi', label: 'Tiếng Việt' },
      ],
    },
    onChange: async (val, ctx) => {
      try {
        if (await changeLanguage(ctx.db.language)) langState.changed = true
      } catch (error) {
        alertError(error)
      }
    },
  },

  {
    id: 'lang.restartWarn',
    type: 'header',
    fallbackLabel: 'Close the settings to take effect',
    options: { level: 'span' },
    classes: 'bg-red-500 text-sm',
    condition: () => langState.changed,
  },

  // Translator Base
  {
    id: 'lang.translatorLang',
    type: 'select',
    labelKey: 'translatorLanguage',
    bindKey: 'translator',
    classes: 'mt-4',
    options: {
      selectFallbackValue: '',
      selectOptions: [
        { value: '', labelKey: 'disabled' },
        { value: 'ko', label: 'Korean' },
        { value: 'ru', label: 'Russian' },
        { value: 'zh', label: 'Chinese' },
        { value: 'zh-TW', label: 'Chinese (Traditional)' },
        { value: 'fa', label: 'Persian (Farsi)' },
        { value: 'ja', label: 'Japanese' },
        { value: 'fr', label: 'French' },
        { value: 'es', label: 'Spanish' },
        { value: 'pt', label: 'Portuguese' },
        { value: 'de', label: 'German' },
        { value: 'id', label: 'Indonesian' },
        { value: 'ms', label: 'Malaysian' },
        { value: 'uk', label: 'Ukranian' },
      ],
    },
  },

  {
    id: 'lang.translatorType',
    type: 'select',
    labelKey: 'translatorType',
    bindKey: 'translatorType',
    classes: 'mt-4',
    condition: (ctx) => !!ctx.db.translator,
    options: {
      selectOptions: [
        { value: 'google', label: 'Google' },
        { value: 'deepl', label: 'DeepL' },
        { value: 'llm', label: 'Ax. Model' },
        { value: 'deeplX', label: 'DeepL X' },
      ],
    },
  },

  // Translator Specific Configurations
  {
    id: 'lang.deeplWebWarn',
    type: 'header',
    labelKey: 'webdeeplwarn',
    options: { level: 'warning' },
    condition: (ctx) => !!ctx.db.translator && ctx.db.translatorType === 'deepl',
  },

  {
    id: 'lang.deeplKey',
    type: 'text',
    labelKey: 'deeplKey',
    bindPath: 'deeplOptions.key',
    classes: 'mt-4',
    options: { hideText: true },
    condition: (ctx) => !!ctx.db.translator && ctx.db.translatorType === 'deepl',
  },

  {
    id: 'lang.deeplFree',
    type: 'check',
    labelKey: 'deeplFreeKey',
    bindPath: 'deeplOptions.freeApi',
    classes: 'mt-2',
    condition: (ctx) => !!ctx.db.translator && ctx.db.translatorType === 'deepl',
  },

  {
    id: 'lang.deeplXUrl',
    type: 'text',
    labelKey: 'deeplXUrl',
    bindPath: 'deeplXOptions.url',
    classes: 'mt-4',
    condition: (ctx) => !!ctx.db.translator && ctx.db.translatorType === 'deeplX',
  },

  {
    id: 'lang.deeplXToken',
    type: 'text',
    labelKey: 'deeplXToken',
    bindPath: 'deeplXOptions.token',
    classes: 'mt-4',
    options: { hideText: true },
    condition: (ctx) => !!ctx.db.translator && ctx.db.translatorType === 'deeplX',
  },

  {
    id: 'lang.llmPresets',
    type: 'custom',
    componentId: 'TranslatorPresetSettings',
    condition: (ctx) => !!ctx.db.translator && ctx.db.translatorType === 'llm',
  },

  {
    id: 'lang.googleSourceLang',
    type: 'select',
    labelKey: 'sourceLanguage',
    bindKey: 'translatorInputLanguage',
    classes: 'mt-4',
    condition: (ctx) => !!ctx.db.translator && ctx.db.translatorType === 'google',
    options: {
      selectOptions: [
        { value: 'auto', label: 'Auto' },
        { value: 'en', label: 'English' },
        { value: 'zh', label: 'Chinese' },
        { value: 'ja', label: 'Japanese' },
        { value: 'ko', label: 'Korean' },
        { value: 'fr', label: 'French' },
        { value: 'es', label: 'Spanish' },
        { value: 'de', label: 'German' },
        { value: 'ru', label: 'Russian' },
      ],
    },
  },

  // General Translation Options
  {
    id: 'acc.showTranslationLoading',
    type: 'check',
    labelKey: 'showTranslationLoading',
    bindKey: 'showTranslationLoading',
    keywords: ['translation', 'loading', 'indicator'],
    classes: 'mt-4',
    condition: (ctx) => !!ctx.db.translator,
  },

  {
    id: 'adv.noWaitTrans',
    type: 'check',
    labelKey: 'noWaitForTranslate',
    bindKey: 'noWaitForTranslate',
    classes: 'mt-4',
    condition: (ctx) => !!ctx.db.translator,
  },

  {
    id: 'adv.exp.googleTrans',
    type: 'check',
    fallbackLabel: 'New Google Translate Experimental',
    bindKey: 'useExperimentalGoogleTranslator',
    condition: (ctx) => !!ctx.db.translator && ctx.db.translatorType === 'google' && ctx.db.useExperimental,
    helpKey: 'unrecommended',
    helpUnrecommended: true,
    classes: 'mt-4',
  },

  {
    id: 'lang.combineTranslation',
    type: 'check',
    labelKey: 'combineTranslation',
    bindKey: 'combineTranslation',
    helpKey: 'combineTranslation',
    classes: 'mt-4',
    condition: (ctx) => !!ctx.db.translator,
  },

  {
    id: 'lang.legacyTranslation',
    type: 'check',
    labelKey: 'legacyTranslation',
    bindKey: 'legacyTranslation',
    helpKey: 'legacyTranslation',
    classes: 'mt-4',
    condition: (ctx) => !!ctx.db.translator,
  },

  {
    id: 'lang.translateBeforeHTML',
    type: 'check',
    labelKey: 'translateBeforeHTMLFormatting',
    bindKey: 'translateBeforeHTMLFormatting',
    helpKey: 'translateBeforeHTMLFormatting',
    classes: 'mt-4',
    condition: (ctx) => !!ctx.db.translator && ctx.db.translatorType === 'llm',
  },

  {
    id: 'lang.translatorSendTextAsIs',
    type: 'check',
    labelKey: 'translatorSendTextAsIs',
    bindKey: 'translatorSendTextAsIs',
    helpKey: 'translatorSendTextAsIs',
    getValue: (db) => db.translatorSendTextAsIs ?? false,
    classes: 'mt-4',
    condition: (ctx) => !!ctx.db.translator && ctx.db.translatorType === 'llm',
  },

  {
    id: 'lang.translatorExcludeThoughts',
    type: 'check',
    labelKey: 'translatorExcludeThoughts',
    bindKey: 'translatorExcludeThoughts',
    helpKey: 'translatorExcludeThoughts',
    getValue: (db) => db.translatorExcludeThoughts ?? false,
    classes: 'mt-4',
    condition: (ctx) =>
      !!ctx.db.translator && ctx.db.translatorType === 'llm' && ctx.db.translatorSendTextAsIs === true,
  },

  {
    id: 'lang.translatorHistoryMaxTokens',
    type: 'number',
    labelKey: 'translatorHistoryMaxTokens',
    bindKey: 'translatorHistoryMaxTokens',
    helpKey: 'translatorHistoryMaxTokens',
    getValue: (db) => {
      const value = db.translatorHistoryMaxTokens ?? 2048
      return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 2048
    },
    classes: 'mt-4',
    options: { min: 1, step: 1 },
    condition: (ctx) => !!ctx.db.translator && ctx.db.translatorType === 'llm',
  },

  {
    id: 'lang.autoTranslateCachedOnly',
    type: 'check',
    labelKey: 'autoTranslateCachedOnly',
    bindKey: 'autoTranslateCachedOnly',
    helpKey: 'autoTranslateCachedOnly',
    classes: 'mt-4',
    condition: (ctx) => !!ctx.db.translator && ctx.db.translatorType === 'llm',
  },

  // Translation Cache
  {
    id: 'lang.exportCache',
    type: 'button',
    labelKey: 'exportTranslationCache',
    classes: 'mt-4',
    condition: (ctx) => !!ctx.db.translator && ctx.db.translatorType === 'llm',
    options: {
      onClick: async () => {
        alertWait(language.loading)
        try {
          const cache = await exportLLMCacheAsJSON()
          const entries = Object.keys(cache).length
          if (entries === 0) {
            alertNormal(language.exportTranslationCacheEmpty)
            return
          }
          const json = JSON.stringify(cache, null, 2)
          await downloadFile('translation_cache.json', new TextEncoder().encode(json))
          alertNormal(language.exportTranslationCacheSuccess)
        } catch (e: any) {
          alertError(e.message)
        }
      },
    },
  },

  {
    id: 'lang.importCache',
    type: 'button',
    labelKey: 'importTranslationCache',
    classes: 'mt-2',
    condition: (ctx) => !!ctx.db.translator && ctx.db.translatorType === 'llm',
    options: {
      onClick: async () => {
        try {
          const files = await selectFileByDom(['.json'])
          if (!files || files.length === 0) return
          if (!files[0].name.endsWith('.json')) {
            alertError('Invalid file type. Please select a .json file.')
            return
          }
          const text = await files[0].text()
          const data = JSON.parse(text)
          if (typeof data !== 'object' || Array.isArray(data)) {
            alertError('Invalid JSON format')
            return
          }
          for (const [key, value] of Object.entries(data)) {
            if (typeof key !== 'string' || typeof value !== 'string') {
              alertError('Invalid JSON format')
              return
            }
          }
          const confirmed = await alertConfirm(language.importTranslationCacheConfirm)
          if (!confirmed) return
          alertWait(language.loading)
          const { count, failed } = await importLLMCacheFromJSON(data as Record<string, string>)
          if (failed > 0) {
            alertError(
              language.importTranslationCacheFailed.replace('{0}', String(count)).replace('{1}', String(failed)),
            )
          } else {
            alertNormal(language.importTranslationCacheSuccess.replace('{0}', String(count)))
          }
        } catch (e: any) {
          alertError(e.message)
        }
      },
    },
  },

  {
    id: 'lang.clearCache',
    type: 'button',
    labelKey: 'clearTranslationCache',
    classes: 'mt-2',
    condition: (ctx) => !!ctx.db.translator && ctx.db.translatorType === 'llm',
    options: {
      onClick: async () => {
        try {
          const confirmed = await alertConfirm(language.clearTranslationCacheConfirm)
          if (!confirmed) return
          alertWait(language.loading)
          await clearLLMCache()
          alertNormal(language.clearTranslationCacheSuccess)
        } catch (e: any) {
          alertError(e.message)
        }
      },
    },
  },
]

const supplementalLanguageSettingIds = new Set(['acc.showTranslationLoading', 'adv.noWaitTrans', 'adv.exp.googleTrans'])

export const languageSupplementalSettingsItems = languageSettingsItems.filter((item) =>
  supplementalLanguageSettingIds.has(item.id),
)
