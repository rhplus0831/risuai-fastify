import {
  captureClientWriteOperation,
  assertClientWriteOperation,
  isClientWriteOperationCurrent,
  awaitClientWriteOperation,
} from '../clientWriteOperation'
import { parseChatML } from '../parser/chatML'
import { risuChatParser } from '../parser/parser.svelte'
import { type Chat, type character } from '../storage/database.svelte'
import { setSelectedPersonaPromptFromTrigger } from '../persona'
import { tokenize } from '../tokenizer'
import { getModuleTriggerOwner, getModuleTriggers } from './modules'
import { get } from 'svelte/store'
import { CurrentTriggerIdStore, refreshVariableOnlyGui, reloadChatAt } from '../stores.svelte'
import { processMultiCommand } from './command'
// Trigger effects reuse the
// compiled-regex memo (lastIndex resets on retrieval).
import { getCompiledRegex } from './scripts'
import { parseKeyValue, sleep } from '../util'
import { alertError, alertInput, alertNormal, alertSelect } from '../alert'
import type { OpenAIChat } from './index.svelte'
import { HypaProcesser } from './memory/hypamemory'
import { requestChatData } from './request/request'
import { generateAIImage } from './stableDiff'
import { writeInlayImage } from './files/inlays'
import { runScripted } from './scriptings'
import {
  scriptModelOverrideProfileId,
  type ScriptModelOverrides,
  type ScriptModelRole,
} from '@risuai/shared-core/script-model-overrides'
import { calcString } from './infunctions'
import {
  currentChatScriptstateSnapshot,
  dispatchPatchChatScriptstateScoped,
  dispatchUpdateChatNoteScoped,
  type ChatScriptstateSnapshot,
} from '../chatCommands'
import { replaceCharacterLorebookCollectionWithOutcome } from '../server/lorebookOwner.svelte'
import {
  applyChatMetadataOwnerPatch,
  applyChatScriptstateOwnerValue,
  charactersResourceState,
  getPersonaOwnerStateSnapshot,
  settingsResourceState,
} from '../server/resourceState.svelte'
import { applyCharacterRowMutationScoped } from '../characterCommands'

export interface triggerscript {
  id?: string
  comment: string
  type: 'start' | 'manual' | 'output' | 'input' | 'display' | 'request'
  conditions: triggerCondition[]
  effect: triggerEffect[]
  lowLevelAccess?: boolean
}

function triggerSettings() {
  return settingsResourceState.status === 'error' ? {} : settingsResourceState.value
}

function scriptModelOverridesForTrigger(trigger: triggerscript, char: character): ScriptModelOverrides | undefined {
  return getModuleTriggerOwner(trigger)?.scriptModelOverrides ?? char.scriptModelOverrides
}

export type triggerCondition = triggerConditionsVar | triggerConditionsExists | triggerConditionsChatIndex

export type triggerEffect = triggerEffectV1 | triggerCode | triggerEffectV2
export type triggerEffectV1 =
  | triggerEffectCutChat
  | triggerEffectModifyChat
  | triggerEffectImgGen
  | triggerEffectRegex
  | triggerEffectRunLLM
  | triggerEffectCheckSimilarity
  | triggerEffectSendAIprompt
  | triggerEffectShowAlert
  | triggerEffectSetvar
  | triggerEffectSystemPrompt
  | triggerEffectImpersonate
  | triggerEffectCommand
  | triggerEffectStop
  | triggerEffectRunTrigger
  | triggerEffectRunAxLLM
export type triggerEffectV2 =
  | triggerV2Header
  | triggerV2IfVar
  | triggerV2Else
  | triggerV2EndIndent
  | triggerV2SetVar
  | triggerV2Loop
  | triggerV2BreakLoop
  | triggerV2RunTrigger
  | triggerV2ConsoleLog
  | triggerV2StopTrigger
  | triggerV2CutChat
  | triggerV2ModifyChat
  | triggerV2SystemPrompt
  | triggerV2Impersonate
  | triggerV2Command
  | triggerV2SendAIprompt
  | triggerV2ImgGen
  | triggerV2CheckSimilarity
  | triggerV2RunLLM
  | triggerV2ShowAlert
  | triggerV2ExtractRegex
  | triggerV2GetLastMessage
  | triggerV2GetMessageAtIndex
  | triggerV2GetMessageCount
  | triggerV2ModifyLorebook
  | triggerV2GetLorebook
  | triggerV2GetLorebookCount
  | triggerV2GetLorebookEntry
  | triggerV2SetLorebookActivation
  | triggerV2GetLorebookIndexViaName
  | triggerV2LoopNTimes
  | triggerV2Random
  | triggerV2GetCharAt
  | triggerV2GetCharCount
  | triggerV2ToLowerCase
  | triggerV2ToUpperCase
  | triggerV2SetCharAt
  | triggerV2SplitString
  | triggerV2JoinArrayVar
  | triggerV2GetCharacterDesc
  | triggerV2SetCharacterDesc
  | triggerV2GetPersonaDesc
  | triggerV2SetPersonaDesc
  | triggerV2MakeArrayVar
  | triggerV2GetArrayVarLength
  | triggerV2GetArrayVar
  | triggerV2SetArrayVar
  | triggerV2PushArrayVar
  | triggerV2PopArrayVar
  | triggerV2ShiftArrayVar
  | triggerV2UnshiftArrayVar
  | triggerV2SpliceArrayVar
  | triggerV2GetFirstMessage
  | triggerV2SliceArrayVar
  | triggerV2GetIndexOfValueInArrayVar
  | triggerV2RemoveIndexFromArrayVar
  | triggerV2ConcatString
  | triggerV2GetLastUserMessage
  | triggerV2GetLastCharMessage
  | triggerV2GetAlertInput
  | triggerV2GetAlertSelect
  | triggerV2GetDisplayState
  | triggerV2SetDisplayState
  | triggerV2UpdateGUI
  | triggerV2UpdateChatAt
  | triggerV2Wait
  | triggerV2GetRequestState
  | triggerV2SetRequestState
  | triggerV2GetRequestStateRole
  | triggerV2SetRequestStateRole
  | triggerV2GetRequestStateLength
  | triggerV2IfAdvanced
  | triggerV2QuickSearchChat
  | triggerV2StopPromptSending
  | triggerV2Tokenize
  | triggerV2GetAllLorebooks
  | triggerV2GetLorebookByName
  | triggerV2GetLorebookByIndex
  | triggerV2CreateLorebook
  | triggerV2ModifyLorebookByIndex
  | triggerV2DeleteLorebookByIndex
  | triggerV2GetLorebookCountNew
  | triggerV2SetLorebookAlwaysActive
  | triggerV2RegexTest
  | triggerV2GetReplaceGlobalNote
  | triggerV2SetReplaceGlobalNote
  | triggerV2GetAuthorNote
  | triggerV2SetAuthorNote
  | triggerV2MakeDictVar
  | triggerV2GetDictVar
  | triggerV2SetDictVar
  | triggerV2DeleteDictKey
  | triggerV2HasDictKey
  | triggerV2ClearDict
  | triggerV2GetDictSize
  | triggerV2GetDictKeys
  | triggerV2GetDictValues
  | triggerV2Calculate
  | triggerV2ReplaceString
  | triggerV2Comment
  | triggerV2DeclareLocalVar

export type triggerConditionsVar = {
  type: 'var' | 'value'
  var: string
  value: string
  operator: '=' | '!=' | '>' | '<' | '>=' | '<=' | 'null' | 'true'
}

export type triggerCode = {
  type: 'triggercode' | 'triggerlua'
  code: string
}

export type triggerConditionsChatIndex = {
  type: 'chatindex'
  value: string
  operator: '=' | '!=' | '>' | '<' | '>=' | '<=' | 'null' | 'true'
}

export type triggerConditionsExists = {
  type: 'exists'
  value: string
  type2: 'strict' | 'loose' | 'regex'
  depth: number
}

export interface triggerEffectSetvar {
  type: 'setvar'
  operator: '=' | '+=' | '-=' | '*=' | '/='
  var: string
  value: string
}

export interface triggerEffectCutChat {
  type: 'cutchat'
  start: string
  end: string
}

export interface triggerEffectModifyChat {
  type: 'modifychat'
  index: string
  value: string
}

export interface triggerEffectSystemPrompt {
  type: 'systemprompt'
  location: 'start' | 'historyend' | 'promptend'
  value: string
}

export interface triggerEffectImpersonate {
  type: 'impersonate'
  role: 'user' | 'char'
  value: string
}

type triggerMode = 'start' | 'manual' | 'output' | 'input' | 'display' | 'request'

export interface triggerEffectCommand {
  type: 'command'
  value: string
}

export interface triggerEffectRegex {
  type: 'extractRegex'
  value: string
  regex: string
  flags: string
  result: string
  inputVar: string
}

export interface triggerEffectShowAlert {
  type: 'showAlert'
  alertType: string
  value: string
  inputVar: string
}

export interface triggerEffectRunTrigger {
  type: 'runtrigger'
  value: string
}

export interface triggerEffectStop {
  type: 'stop'
}

export interface triggerEffectSendAIprompt {
  type: 'sendAIprompt'
}

export interface triggerEffectImgGen {
  type: 'runImgGen'
  value: string
  negValue: string
  inputVar: string
}

export interface triggerEffectCheckSimilarity {
  type: 'checkSimilarity'
  source: string
  value: string
  inputVar: string
}

export interface triggerEffectRunLLM {
  type: 'runLLM'
  value: string
  inputVar: string
}

export interface triggerEffectRunAxLLM {
  type: 'runAxLLM'
  value: string
  inputVar: string
}

export type additonalSysPrompt = {
  start: string
  historyend: string
  promptend: string
}

export type triggerV2Header = {
  type: 'v2Header'
  code?: string
  indent: number
}

export type triggerV2IfVar = {
  type: 'v2If'
  condition: '=' | '!=' | '>' | '<' | '>=' | '<='
  targetType: 'var' | 'value'
  target: string
  source: string
  indent: number
}

export type triggerV2Else = {
  type: 'v2Else'
  indent: number
}

export type triggerV2EndIndent = {
  type: 'v2EndIndent'
  endOfLoop?: boolean
  indent: number
}

export type triggerV2SetVar = {
  type: 'v2SetVar'
  operator: '=' | '+=' | '-=' | '*=' | '/=' | '%='
  var: string
  valueType: 'var' | 'value'
  value: string
  indent: number
}

export type triggerV2Loop = {
  type: 'v2Loop'
  indent: number
}

export type triggerV2LoopNTimes = {
  type: 'v2LoopNTimes'
  value: string
  valueType: 'var' | 'value'
  indent: number
}

export type triggerV2BreakLoop = {
  type: 'v2BreakLoop'
  indent: number
}

export type triggerV2RunTrigger = {
  type: 'v2RunTrigger'
  target: string
  indent: number
}

export type triggerV2ConsoleLog = {
  type: 'v2ConsoleLog'
  sourceType: 'var' | 'value'
  source: string
  indent: number
}

export type triggerV2StopTrigger = {
  type: 'v2StopTrigger'
  indent: number
}

export type triggerV2CutChat = {
  type: 'v2CutChat'
  start: string
  startType: 'var' | 'value'
  end: string
  endType: 'var' | 'value'
  indent: number
}

export type triggerV2ModifyChat = {
  type: 'v2ModifyChat'
  index: string
  indexType: 'var' | 'value'
  value: string
  valueType: 'var' | 'value'
  indent: number
}

export type triggerV2SystemPrompt = {
  type: 'v2SystemPrompt'
  location: 'start' | 'historyend' | 'promptend'
  value: string
  valueType: 'var' | 'value'
  indent: number
}

export type triggerV2Impersonate = {
  type: 'v2Impersonate'
  role: 'user' | 'char'
  value: string
  valueType: 'var' | 'value'
  indent: number
}

export type triggerV2Command = {
  type: 'v2Command'
  value: string
  valueType: 'var' | 'value'
  indent: number
}

export type triggerV2SendAIprompt = {
  type: 'v2SendAIprompt'
  indent: number
}

export type triggerV2ImgGen = {
  type: 'v2ImgGen'
  value: string
  valueType: 'var' | 'value'
  negValue: string
  negValueType: 'var' | 'value'
  outputVar: string
  indent: number
}

export type triggerV2CheckSimilarity = {
  type: 'v2CheckSimilarity'
  source: string
  sourceType: 'var' | 'value'
  value: string
  valueType: 'var' | 'value'
  outputVar: string
  indent: number
}

export type triggerV2RunLLM = {
  type: 'v2RunLLM'
  value: string
  valueType: 'var' | 'value'
  model: 'model' | 'submodel' | 'otherAx' | 'scriptMain' | 'scriptAux'
  streaming?: boolean
  outputVar: string
  indent: number
}

function normalizeTriggerLLMMode(mode: triggerV2RunLLM['model']): ScriptModelRole {
  if (mode === 'model') return 'scriptMain'
  if (mode === 'submodel' || mode === 'otherAx') return 'scriptAux'
  return mode
}

export type triggerV2ShowAlert = {
  type: 'v2ShowAlert'
  value: string
  valueType: 'var' | 'value'
  indent: number
}

export type triggerV2ExtractRegex = {
  type: 'v2ExtractRegex'
  value: string
  valueType: 'var' | 'value'
  regex: string
  regexType: 'var' | 'value'
  flags: string
  flagsType: 'var' | 'value'
  result: string
  resultType: 'var' | 'value'
  outputVar: string
  indent: number
}

export type triggerV2GetLastMessage = {
  type: 'v2GetLastMessage'
  outputVar: string
  indent: number
}

export type triggerV2GetMessageAtIndex = {
  type: 'v2GetMessageAtIndex'
  index: string
  indexType: 'var' | 'value'
  outputVar: string
  indent: number
}

export type triggerV2GetMessageCount = {
  type: 'v2GetMessageCount'
  outputVar: string
  indent: number
}

export type triggerV2ModifyLorebook = {
  type: 'v2ModifyLorebook'
  target: string
  targetType: 'var' | 'value'
  value: string
  valueType: 'var' | 'value'
  indent: number
}

export type triggerV2GetLorebook = {
  type: 'v2GetLorebook'
  target: string
  targetType: 'var' | 'value'
  outputVar: string
  indent: number
}

export type triggerV2GetLorebookCount = {
  type: 'v2GetLorebookCount'
  outputVar: string
  indent: number
}

export type triggerV2GetLorebookEntry = {
  type: 'v2GetLorebookEntry'
  index: string
  indexType: 'var' | 'value'
  outputVar: string
  indent: number
}

export type triggerV2SetLorebookActivation = {
  type: 'v2SetLorebookActivation'
  index: string
  indexType: 'var' | 'value'
  value: boolean
  indent: number
}

export type triggerV2GetLorebookIndexViaName = {
  type: 'v2GetLorebookIndexViaName'
  name: string
  nameType: 'var' | 'value'
  outputVar: string
  indent: number
}

export type triggerV2Random = {
  type: 'v2Random'
  min: string
  minType: 'var' | 'value'
  max: string
  maxType: 'var' | 'value'
  outputVar: string
  indent: number
}

export type triggerV2GetCharAt = {
  type: 'v2GetCharAt'
  source: string
  sourceType: 'var' | 'value'
  index: string
  indexType: 'var' | 'value'
  outputVar: string
  indent: number
}

export type triggerV2GetCharCount = {
  type: 'v2GetCharCount'
  source: string
  sourceType: 'var' | 'value'
  outputVar: string
  indent: number
}

export type triggerV2ToLowerCase = {
  type: 'v2ToLowerCase'
  source: string
  sourceType: 'var' | 'value'
  outputVar: string
  indent: number
}

export type triggerV2ToUpperCase = {
  type: 'v2ToUpperCase'
  source: string
  sourceType: 'var' | 'value'
  outputVar: string
  indent: number
}

export type triggerV2SetCharAt = {
  type: 'v2SetCharAt'
  source: string
  sourceType: 'var' | 'value'
  index: string
  indexType: 'var' | 'value'
  value: string
  valueType: 'var' | 'value'
  outputVar: string
  indent: number
}

export type triggerV2SplitString = {
  type: 'v2SplitString'
  source: string
  sourceType: 'var' | 'value'
  delimiter: string
  delimiterType: 'var' | 'value' | 'regex'
  outputVar: string
  indent: number
}

export type triggerV2JoinArrayVar = {
  type: 'v2JoinArrayVar'
  var: string
  varType: 'var' | 'value'
  delimiter: string
  delimiterType: 'var' | 'value'
  outputVar: string
  indent: number
}

export type triggerV2GetCharacterDesc = {
  type: 'v2GetCharacterDesc'
  outputVar: string
  indent: number
}

export type triggerV2SetCharacterDesc = {
  type: 'v2SetCharacterDesc'
  value: string
  valueType: 'var' | 'value'
  indent: number
}

export type triggerV2GetPersonaDesc = {
  type: 'v2GetPersonaDesc'
  outputVar: string
  indent: number
}

export type triggerV2SetPersonaDesc = {
  type: 'v2SetPersonaDesc'
  value: string
  valueType: 'var' | 'value'
  indent: number
}

export type triggerV2MakeArrayVar = {
  type: 'v2MakeArrayVar'
  var: string
  indent: number
}

export type triggerV2GetArrayVarLength = {
  type: 'v2GetArrayVarLength'
  var: string
  outputVar: string
  indent: number
}

export type triggerV2GetArrayVar = {
  type: 'v2GetArrayVar'
  var: string
  index: string
  indexType: 'var' | 'value'
  outputVar: string
  indent: number
}

export type triggerV2SetArrayVar = {
  type: 'v2SetArrayVar'
  var: string
  index: string
  indexType: 'var' | 'value'
  value: string
  valueType: 'var' | 'value'
  indent: number
}

export type triggerV2PushArrayVar = {
  type: 'v2PushArrayVar'
  var: string
  value: string
  valueType: 'var' | 'value'
  indent: number
}

export type triggerV2PopArrayVar = {
  type: 'v2PopArrayVar'
  var: string
  outputVar: string
  indent: number
}

export type triggerV2ShiftArrayVar = {
  type: 'v2ShiftArrayVar'
  var: string
  outputVar: string
  indent: number
}

export type triggerV2UnshiftArrayVar = {
  type: 'v2UnshiftArrayVar'
  var: string
  value: string
  valueType: 'var' | 'value'
  indent: number
}

export type triggerV2SpliceArrayVar = {
  type: 'v2SpliceArrayVar'
  var: string
  start: string
  startType: 'var' | 'value'
  item: string
  itemType: 'var' | 'value'
  indent: number
}

export type triggerV2SliceArrayVar = {
  type: 'v2SliceArrayVar'
  var: string
  start: string
  startType: 'var' | 'value'
  end: string
  endType: 'var' | 'value'
  outputVar: string
  indent: number
}

export type triggerV2GetIndexOfValueInArrayVar = {
  type: 'v2GetIndexOfValueInArrayVar'
  var: string
  value: string
  valueType: 'var' | 'value'
  outputVar: string
  indent: number
}

export type triggerV2RemoveIndexFromArrayVar = {
  type: 'v2RemoveIndexFromArrayVar'
  var: string
  index: string
  indexType: 'var' | 'value'
  indent: number
}

export type triggerV2ConcatString = {
  type: 'v2ConcatString'
  source1: string
  source1Type: 'var' | 'value'
  source2: string
  source2Type: 'var' | 'value'
  outputVar: string
  indent: number
}

export type triggerV2GetLastUserMessage = {
  type: 'v2GetLastUserMessage'
  outputVar: string
  indent: number
}

export type triggerV2GetLastCharMessage = {
  type: 'v2GetLastCharMessage'
  outputVar: string
  indent: number
}

export type triggerV2GetFirstMessage = {
  type: 'v2GetFirstMessage'
  outputVar: string
  indent: number
}

export type triggerV2GetAlertInput = {
  type: 'v2GetAlertInput'
  display: string
  displayType: 'var' | 'value'
  outputVar: string
  indent: number
}

export type triggerV2GetDisplayState = {
  type: 'v2GetDisplayState'
  outputVar: string
  indent: number
}

export type triggerV2SetDisplayState = {
  type: 'v2SetDisplayState'
  value: string
  valueType: 'var' | 'value'
  indent: number
}

export type triggerV2GetRequestState = {
  type: 'v2GetRequestState'
  outputVar: string
  index: string
  indexType: 'var' | 'value'
  indent: number
}

export type triggerV2GetRequestStateRole = {
  type: 'v2GetRequestStateRole'
  outputVar: string
  index: string
  indexType: 'var' | 'value'
  indent: number
}

export type triggerV2SetRequestState = {
  type: 'v2SetRequestState'
  value: string
  valueType: 'var' | 'value'
  index: string
  indexType: 'var' | 'value'
  indent: number
}

export type triggerV2SetRequestStateRole = {
  type: 'v2SetRequestStateRole'
  value: string
  valueType: 'var' | 'value'
  index: string
  indexType: 'var' | 'value'
  indent: number
}

export type triggerV2GetRequestStateLength = {
  type: 'v2GetRequestStateLength'
  outputVar: string
  indent: number
}

export type triggerV2UpdateGUI = {
  type: 'v2UpdateGUI'
  indent: number
}

export type triggerV2UpdateChatAt = {
  type: 'v2UpdateChatAt'
  index: string
  indent: number
}

export type triggerV2Wait = {
  type: 'v2Wait'
  value: string
  valueType: 'var' | 'value'
  indent: number
}

export type triggerV2IfAdvanced = {
  type: 'v2IfAdvanced'
  condition: '=' | '!=' | '>' | '<' | '>=' | '<=' | '≒' | '∋' | '∈' | '∌' | '∉' | '≡'
  targetType: 'var' | 'value'
  target: string
  sourceType: 'var' | 'value'
  source: string
  indent: number
}

export type triggerV2QuickSearchChat = {
  type: 'v2QuickSearchChat'
  value: string
  valueType: 'var' | 'value'
  condition: 'loose' | 'strict' | 'regex'
  depth: string
  depthType: 'var' | 'value'
  outputVar: string
  indent: number
}

export type triggerV2StopPromptSending = {
  type: 'v2StopPromptSending'
  indent: number
}

export type triggerV2Tokenize = {
  type: 'v2Tokenize'
  indent: number
  value: string
  valueType: 'var' | 'value'
  outputVar: string
}

export type triggerV2GetAllLorebooks = {
  type: 'v2GetAllLorebooks'
  outputVar: string
  indent: number
}
export type triggerV2RegexTest = {
  type: 'v2RegexTest'
  value: string
  valueType: 'var' | 'value'
  regex: string
  regexType: 'var' | 'value'
  flags: string
  flagsType: 'var' | 'value'
  outputVar: string
  indent: number
}

export type triggerV2GetLorebookByName = {
  type: 'v2GetLorebookByName'
  name: string
  nameType: 'var' | 'value'
  outputVar: string
  indent: number
}

export type triggerV2GetLorebookByIndex = {
  type: 'v2GetLorebookByIndex'
  index: string
  indexType: 'var' | 'value'
  outputVar: string
  indent: number
}

export type triggerV2CreateLorebook = {
  type: 'v2CreateLorebook'
  name: string
  nameType: 'var' | 'value'
  key: string
  keyType: 'var' | 'value'
  content: string
  contentType: 'var' | 'value'
  insertOrder: string
  insertOrderType: 'var' | 'value'
  indent: number
}

export type triggerV2ModifyLorebookByIndex = {
  type: 'v2ModifyLorebookByIndex'
  index: string
  indexType: 'var' | 'value'
  name: string
  nameType: 'var' | 'value'
  key: string
  keyType: 'var' | 'value'
  content: string
  contentType: 'var' | 'value'
  insertOrder: string
  insertOrderType: 'var' | 'value'
  indent: number
}

export type triggerV2DeleteLorebookByIndex = {
  type: 'v2DeleteLorebookByIndex'
  index: string
  indexType: 'var' | 'value'
  indent: number
}

export type triggerV2GetLorebookCountNew = {
  type: 'v2GetLorebookCountNew'
  outputVar: string
  indent: number
}

export type triggerV2SetLorebookAlwaysActive = {
  type: 'v2SetLorebookAlwaysActive'
  index: string
  indexType: 'var' | 'value'
  value: boolean
  indent: number
}

export type triggerV2GetAlertSelect = {
  type: 'v2GetAlertSelect'
  display: string
  displayType: 'var' | 'value'
  value: string
  valueType: 'var' | 'value'
  outputVar: string
  indent: number
}

export type triggerV2GetReplaceGlobalNote = {
  type: 'v2GetReplaceGlobalNote'
  outputVar: string
  indent: number
}

export type triggerV2SetReplaceGlobalNote = {
  type: 'v2SetReplaceGlobalNote'
  value: string
  valueType: 'var' | 'value'
  indent: number
}

export type triggerV2GetAuthorNote = {
  type: 'v2GetAuthorNote'
  outputVar: string
  indent: number
}

export type triggerV2SetAuthorNote = {
  type: 'v2SetAuthorNote'
  value: string
  valueType: 'var' | 'value'
  indent: number
}

export type triggerV2MakeDictVar = {
  type: 'v2MakeDictVar'
  var: string
  indent: number
}

export type triggerV2GetDictVar = {
  type: 'v2GetDictVar'
  var: string
  varType: 'var' | 'value'
  key: string
  keyType: 'var' | 'value'
  outputVar: string
  indent: number
}

export type triggerV2SetDictVar = {
  type: 'v2SetDictVar'
  var: string
  varType: 'var' | 'value'
  key: string
  keyType: 'var' | 'value'
  value: string
  valueType: 'var' | 'value'
  indent: number
}

export type triggerV2DeleteDictKey = {
  type: 'v2DeleteDictKey'
  var: string
  varType: 'var' | 'value'
  key: string
  keyType: 'var' | 'value'
  indent: number
}

export type triggerV2HasDictKey = {
  type: 'v2HasDictKey'
  var: string
  varType: 'var' | 'value'
  key: string
  keyType: 'var' | 'value'
  outputVar: string
  indent: number
}

export type triggerV2ClearDict = {
  type: 'v2ClearDict'
  var: string
  indent: number
}

export type triggerV2GetDictSize = {
  type: 'v2GetDictSize'
  var: string
  varType: 'var' | 'value'
  outputVar: string
  indent: number
}

export type triggerV2GetDictKeys = {
  type: 'v2GetDictKeys'
  var: string
  varType: 'var' | 'value'
  outputVar: string
  indent: number
}

export type triggerV2GetDictValues = {
  type: 'v2GetDictValues'
  var: string
  varType: 'var' | 'value'
  outputVar: string
  indent: number
}

export type triggerV2Calculate = {
  type: 'v2Calculate'
  expression: string
  expressionType: 'var' | 'value'
  outputVar: string
  indent: number
}

export type triggerV2ReplaceString = {
  type: 'v2ReplaceString'
  source: string
  sourceType: 'var' | 'value'
  regex: string
  regexType: 'var' | 'value'
  result: string
  resultType: 'var' | 'value'
  replacement: string
  replacementType: 'var' | 'value'
  flags: string
  flagsType: 'var' | 'value'
  outputVar: string
  indent: number
}

export type triggerV2Comment = {
  type: 'v2Comment'
  value: string
  indent: number
}

export type triggerV2DeclareLocalVar = {
  type: 'v2DeclareLocalVar'
  var: string
  value: string
  valueType: 'var' | 'value'
  indent: number
}

const safeSubset = [
  'v2SetVar',
  'v2If',
  'v2IfAdvanced',
  'v2Else',
  'v2EndIndent',
  'v2LoopNTimes',
  'v2BreakLoop',
  'v2ConsoleLog',
  'v2StopTrigger',
  'v2Random',
  'v2ExtractRegex',
  'v2RegexTest',
  'v2GetCharAt',
  'v2GetCharCount',
  'v2ToLowerCase',
  'v2ToUpperCase',
  'v2SetCharAt',
  'v2SplitString',
  'v2JoinArrayVar',
  'v2ConcatString',
  'v2MakeArrayVar',
  'v2GetArrayVarLength',
  'v2GetArrayVar',
  'v2SetArrayVar',
  'v2PushArrayVar',
  'v2PopArrayVar',
  'v2ShiftArrayVar',
  'v2UnshiftArrayVar',
  'v2SpliceArrayVar',
  'v2SliceArrayVar',
  'v2GetIndexOfValueInArrayVar',
  'v2RemoveIndexFromArrayVar',
  'v2Calculate',
  'v2Comment',
  'v2DeclareLocalVar',
]

export const displayAllowList = ['v2GetDisplayState', 'v2SetDisplayState', ...safeSubset]

export const requestAllowList = [
  'v2GetRequestState',
  'v2SetRequestState',
  'v2GetRequestStateRole',
  'v2SetRequestStateRole',
  'v2GetRequestStateLength',
  ...safeSubset,
]

async function collectStreamingText(stream: ReadableStream<{ [key: string]: string }>): Promise<string> {
  const reader = stream.getReader()
  let lastChunk = ''

  while (true) {
    const { done, value } = await reader.read()
    if (value) {
      const firstKey = Object.keys(value)[0]
      if (firstKey) {
        lastChunk = value[firstKey] ?? lastChunk
      }
    }
    if (done) {
      break
    }
  }

  return lastChunk
}

// Persist an in-place working-copy lorebook edit through the character lorebook
// owner. The helper captures the live owner baseline, projects only that list,
// and owns durable rollback/recovery.
function persistCharacterLorebookEdit(char: character): void {
  void replaceCharacterLorebookCollectionWithOutcome(char.chaId, char.globalLore ?? [], 0)
}

function persistCharacterRowField(char: character, mutate: (owner: character) => void): boolean {
  if (charactersResourceState.status !== 'ready' || !char.chaId) return false
  const matches = charactersResourceState.characters
    .map((candidate, index) => ({ candidate, index }))
    .filter(({ candidate }) => candidate?.chaId === char.chaId)
  if (matches.length !== 1) return false
  return applyCharacterRowMutationScoped(matches[0].index, char.chaId, mutate)
}

export const DEFAULT_TRIGGER_WALL_CLOCK_BUDGET_MS = 3_000
export const DEFAULT_TRIGGER_MAX_EFFECT_STEPS = 100_000
export const DEFAULT_TRIGGER_MAX_LOOP_BACK_EDGES = 10_000
export const DEFAULT_TRIGGER_MAX_RECURSION_DEPTH = 10

type TriggerBudgetStopReason = 'aborted' | 'wallClock' | 'effectSteps' | 'loopBackEdges'

export interface TriggerExecutionBudget {
  startedAtMs: number
  wallClockMs: number
  effectSteps: number
  maxEffectSteps: number
  loopBackEdges: number
  maxLoopBackEdges: number
  maxRecursionDepth: number
  now: () => number
  stoppedReason?: TriggerBudgetStopReason
  stoppedDetail?: string
}

export interface TriggerExecutionBudgetOptions {
  wallClockMs?: number
  maxEffectSteps?: number
  maxLoopBackEdges?: number
  maxRecursionDepth?: number
  now?: () => number
}

export function createTriggerExecutionBudget(opts: TriggerExecutionBudgetOptions = {}): TriggerExecutionBudget {
  const now = opts.now ?? Date.now
  return {
    startedAtMs: now(),
    wallClockMs: opts.wallClockMs ?? DEFAULT_TRIGGER_WALL_CLOCK_BUDGET_MS,
    effectSteps: 0,
    maxEffectSteps: opts.maxEffectSteps ?? DEFAULT_TRIGGER_MAX_EFFECT_STEPS,
    loopBackEdges: 0,
    maxLoopBackEdges: opts.maxLoopBackEdges ?? DEFAULT_TRIGGER_MAX_LOOP_BACK_EDGES,
    maxRecursionDepth: opts.maxRecursionDepth ?? DEFAULT_TRIGGER_MAX_RECURSION_DEPTH,
    now,
  }
}

function markTriggerStopped(budget: TriggerExecutionBudget, reason: TriggerBudgetStopReason, detail: string): void {
  if (budget.stoppedReason) {
    return
  }
  budget.stoppedReason = reason
  budget.stoppedDetail = detail
}

function shouldStopTriggerExecution(
  budget: TriggerExecutionBudget,
  signal: AbortSignal | undefined,
  detail: string,
): boolean {
  if (signal?.aborted) {
    markTriggerStopped(budget, 'aborted', detail)
    return true
  }
  if (budget.stoppedReason) {
    return true
  }
  if (Number.isFinite(budget.wallClockMs) && budget.now() - budget.startedAtMs >= budget.wallClockMs) {
    markTriggerStopped(budget, 'wallClock', detail)
    return true
  }
  return false
}

function chargeTriggerEffectStep(
  budget: TriggerExecutionBudget,
  signal: AbortSignal | undefined,
  effectType: string,
): boolean {
  if (shouldStopTriggerExecution(budget, signal, `before effect ${effectType}`)) {
    return true
  }
  budget.effectSteps++
  if (budget.effectSteps > budget.maxEffectSteps) {
    markTriggerStopped(budget, 'effectSteps', effectType)
    return true
  }
  return false
}

function chargeTriggerLoopBack(
  budget: TriggerExecutionBudget,
  signal: AbortSignal | undefined,
  effectType: string,
): boolean {
  if (shouldStopTriggerExecution(budget, signal, `before ${effectType} loop-back`)) {
    return true
  }
  budget.loopBackEdges++
  if (budget.loopBackEdges > budget.maxLoopBackEdges) {
    markTriggerStopped(budget, 'loopBackEdges', effectType)
    return true
  }
  return false
}

function triggerBudgetRemainingMs(budget: TriggerExecutionBudget): number {
  if (!Number.isFinite(budget.wallClockMs)) {
    return Number.POSITIVE_INFINITY
  }
  return Math.max(0, budget.wallClockMs - (budget.now() - budget.startedAtMs))
}

function markTriggerAfterSleep(
  budget: TriggerExecutionBudget | undefined,
  signal: AbortSignal | undefined,
  sleptToBudgetBoundary: boolean,
): void {
  if (!budget) {
    return
  }
  if (shouldStopTriggerExecution(budget, signal, 'after wait')) {
    return
  }
  if (sleptToBudgetBoundary) {
    markTriggerStopped(budget, 'wallClock', 'after wait')
  }
}

function sleepWithAbort(ms: number, signal: AbortSignal | undefined, budget?: TriggerExecutionBudget): Promise<void> {
  const budgetRemainingMs = budget ? triggerBudgetRemainingMs(budget) : Number.POSITIVE_INFINITY
  const sleepMs = Math.max(0, Math.min(ms, budgetRemainingMs))
  const sleptToBudgetBoundary = Number.isFinite(budgetRemainingMs) && sleepMs >= budgetRemainingMs
  if (!signal) {
    return sleep(sleepMs).then(() => {
      markTriggerAfterSleep(budget, signal, sleptToBudgetBoundary)
    })
  }
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, sleepMs)
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  }).then(() => {
    markTriggerAfterSleep(budget, signal, sleptToBudgetBoundary)
  })
}

let activeManualTriggerAbortController: AbortController | null = null

export function createManualTriggerAbortController(): AbortController {
  activeManualTriggerAbortController?.abort()
  const controller = new AbortController()
  activeManualTriggerAbortController = controller
  return controller
}

export function clearManualTriggerAbortController(controller: AbortController): void {
  if (activeManualTriggerAbortController === controller) {
    activeManualTriggerAbortController = null
  }
}

export async function runTrigger(
  char: character,
  mode: triggerMode,
  arg: {
    chat: Chat
    recursiveCount?: number
    additonalSysPrompt?: additonalSysPrompt
    stopSending?: boolean
    manualName?: string
    triggerId?: string
    displayMode?: boolean
    displayData?: string
    tempVars?: Record<string, string>
    signal?: AbortSignal
    triggerBudget?: TriggerExecutionBudget
    triggerBudgetOptions?: TriggerExecutionBudgetOptions
    isFresh?: () => boolean
    deferLiveChatSideEffects?: boolean
  },
) {
  const clientOperation = captureClientWriteOperation()

  arg.recursiveCount ??= 0
  const triggerBudget = arg.triggerBudget ?? createTriggerExecutionBudget(arg.triggerBudgetOptions)
  let varChanged = false
  let stopSending = arg.stopSending ?? false
  const CharacterlowLevelAccess = char.lowLevelAccess ?? false
  let sendAIprompt = false
  let additonalSysPrompt: additonalSysPrompt = arg.additonalSysPrompt ?? {
    start: '',
    historyend: '',
    promptend: '',
  }
  // Resolve the effective trigger list BEFORE any clone so a zero-trigger
  // character returns early without paying a deep clone. Each character trigger
  // carries the character-level `lowLevelAccess`, but the source trigger rows
  // may be read-only Fastify projection objects, so attach that metadata on
  // shallow copies.
  const charTriggers: triggerscript[] = char.triggerscript.map(
    (v): triggerscript => ({
      ...v,
      lowLevelAccess: CharacterlowLevelAccess,
    }),
  )
  const triggers: triggerscript[] = charTriggers.concat(getModuleTriggers({ character: char, chat: arg.chat }))
  const defaultVariables = parseKeyValue(char.defaultVariables).concat(
    parseKeyValue(triggerSettings().templateDefaultVariables ?? ''),
  )

  const previousTriggerId = get(CurrentTriggerIdStore)
  const shouldSetTriggerId = !arg.displayMode && mode !== 'display'
  if (shouldSetTriggerId) {
    CurrentTriggerIdStore.set(arg.triggerId || null)
  }

  if (!triggers || triggers.length === 0) {
    if (shouldSetTriggerId) {
      CurrentTriggerIdStore.set(previousTriggerId)
    }
    return null
  }

  // Trigger-bearing path. Deep-clone only the active chat (the single heavy clone
  // this pass needs). The working character stays a shallow copy carrying the
  // mapped trigger list and is lazily deep-cloned (`materializeChar`) only when a
  // data effect must install it back into the projection (character desc /
  // author-note / lorebook). The former unconditional `safeStructuredClone(char)`
  // deep-cloned every OTHER chat's full message history on every send even though
  // most triggers never touch durable character state.
  let charMaterialized = arg.displayMode === true
  const materializeChar = (): character => {
    if (!charMaterialized) {
      char = safeStructuredClone(char)
      charMaterialized = true
    }
    return char
  }
  if (!arg.displayMode) {
    char = { ...char, triggerscript: charTriggers } as character
  }
  let chat = arg.displayMode ? arg.chat : safeStructuredClone(arg.chat ?? char.chats[char.chatPage])

  let tempVars: Record<string, string> = arg.tempVars ?? {}
  const isFresh = (): boolean => isClientWriteOperationCurrent(clientOperation) && arg.isFresh?.() !== false
  const shouldApplyLiveChatSideEffects = (): boolean => !arg.deferLiveChatSideEffects && isFresh()

  // One scriptstate-scoped rollback for the whole pass, captured lazily on the
  // first var/author-note write and reused across every `setVar`/`v2SetAuthorNote`
  // in this pass. Captures only the active chat's scriptstate map + note, never
  // the whole characters array, and stays free on display passes that write none.
  let scriptstateRollbackSnapshot: ChatScriptstateSnapshot | null = null
  const captureScriptstateRollback = (): ChatScriptstateSnapshot => {
    scriptstateRollbackSnapshot ??= currentChatScriptstateSnapshot(true)
    return scriptstateRollbackSnapshot
  }

  let localVarScopes: Record<number, Record<string, string>>[] = [{}]
  let currentIndent = 0

  function getLocalVar(key: string): string | null {
    if (!localVarScopes || localVarScopes.length === 0) {
      return null
    }
    const currentScope = localVarScopes[localVarScopes.length - 1]
    if (!currentScope) {
      return null
    }
    for (let indent = currentIndent; indent >= 0; indent--) {
      if (currentScope[indent] && currentScope[indent][key] !== undefined) {
        const value = currentScope[indent][key]
        return value
      }
    }
    return null
  }

  function setLocalVar(key: string, value: string, indent: number): boolean {
    if (!localVarScopes || localVarScopes.length === 0) {
      localVarScopes = [{}]
    }
    const currentScope = localVarScopes[localVarScopes.length - 1]
    if (!currentScope) {
      return false
    }

    const finalValue = value === null || value === undefined ? 'null' : value

    let foundIndent = -1
    for (let i = indent; i >= 0; i--) {
      if (currentScope[i] && currentScope[i][key] !== undefined) {
        foundIndent = i
        break
      }
    }

    const targetIndent = foundIndent !== -1 ? foundIndent : indent

    if (!currentScope[targetIndent]) {
      currentScope[targetIndent] = {}
    }

    if (currentScope[targetIndent][key] === finalValue) {
      return false
    }

    currentScope[targetIndent][key] = finalValue
    return true
  }

  function declareLocalVar(key: string, value: string, indent: number) {
    setLocalVar(key, value, indent)
  }

  function clearLocalVarsAtIndent(indent: number) {
    if (!localVarScopes || localVarScopes.length === 0) {
      return
    }
    const currentScope = localVarScopes[localVarScopes.length - 1]
    if (!currentScope) {
      return
    }
    const indentsToDelete: string[] = []
    for (const scopeIndent in currentScope) {
      if (Number(scopeIndent) >= indent) {
        indentsToDelete.push(scopeIndent)
      }
    }
    indentsToDelete.forEach((indentKey) => {
      delete currentScope[indentKey]
    })
  }

  function getVar(key: string) {
    const localVar = getLocalVar(key)
    if (localVar !== null) {
      return localVar
    }

    const state = chat.scriptstate?.['$' + key]
    if (state === undefined || state === null) {
      const findResult = defaultVariables.find((f) => {
        return f[0] === key
      })
      if (findResult) {
        return findResult[1]
      }
      if (arg.displayMode) {
        return tempVars[key] ?? 'null'
      }
      return 'null'
    }
    return state.toString()
  }

  function setVar(key: string, value: string): boolean {
    assertClientWriteOperation(clientOperation)
    if (arg.displayMode) {
      if (tempVars[key] === value) {
        return false
      }
      tempVars[key] = value
      return true
    }

    const localVar = getLocalVar(key)
    if (localVar !== null) {
      return setLocalVar(key, value, currentIndent)
    }

    const stateKey = '$' + key
    if (chat.scriptstate?.[stateKey] === value) {
      return false
    }

    const shouldDispatchLiveSideEffect = shouldApplyLiveChatSideEffects()
    const previous = shouldDispatchLiveSideEffect ? captureScriptstateRollback() : null
    varChanged = true
    chat.scriptstate ??= {}
    chat.scriptstate[stateKey] = value
    if (
      shouldDispatchLiveSideEffect &&
      chat.id &&
      previous &&
      applyChatScriptstateOwnerValue(char.chaId, chat.id, stateKey, value)
    ) {
      dispatchPatchChatScriptstateScoped(chat.id, { [stateKey]: value }, [], previous)
    }
    return true
  }

  const buildResult = async () => {
    assertClientWriteOperation(clientOperation)
    let caculatedTokens = 0
    if (additonalSysPrompt.start) {
      caculatedTokens += await awaitClientWriteOperation(clientOperation, tokenize(additonalSysPrompt.start))
    }
    if (additonalSysPrompt.historyend) {
      caculatedTokens += await awaitClientWriteOperation(clientOperation, tokenize(additonalSysPrompt.historyend))
    }
    if (additonalSysPrompt.promptend) {
      caculatedTokens += await awaitClientWriteOperation(clientOperation, tokenize(additonalSysPrompt.promptend))
    }
    if (varChanged) {
      if (isFresh()) {
        refreshVariableOnlyGui()
      }
    }
    if (shouldSetTriggerId && mode !== 'manual') {
      CurrentTriggerIdStore.set(previousTriggerId)
    }

    return {
      additonalSysPrompt,
      chat,
      tokens: caculatedTokens,
      stopSending,
      sendAIprompt,
      displayData: arg.displayData,
      tempVars: arg.tempVars,
      triggerStoppedReason: triggerBudget.stoppedReason,
      triggerStoppedDetail: triggerBudget.stoppedDetail,
    }
  }

  for (const trigger of triggers) {
    let tempVars: Record<string, number> = {}

    if (shouldStopTriggerExecution(triggerBudget, arg.signal, 'before trigger pass')) {
      return await awaitClientWriteOperation(clientOperation, buildResult())
    }
    if (!isFresh()) {
      return await awaitClientWriteOperation(clientOperation, buildResult())
    }

    if (trigger.effect[0]?.type === 'triggercode' || trigger.effect[0]?.type === 'triggerlua') {
      //
    } else if (arg.manualName) {
      if (trigger.comment !== arg.manualName) {
        continue
      }
    } else if (mode !== trigger.type) {
      continue
    }

    let pass = true
    for (const condition of trigger.conditions) {
      if (condition.type === 'var' || condition.type === 'chatindex' || condition.type === 'value') {
        let varValue =
          condition.type === 'var'
            ? (getVar(condition.var) ?? 'null')
            : condition.type === 'chatindex'
              ? chat.message.length.toString()
              : condition.type === 'value'
                ? condition.var
                : null

        if (varValue === undefined || varValue === null) {
          pass = false
          break
        } else {
          const conditionValue = risuChatParser(condition.value, { chara: char })
          varValue = risuChatParser(varValue, { chara: char })
          switch (condition.operator) {
            case 'true': {
              if (varValue !== 'true' && varValue !== '1') {
                pass = false
              }
              break
            }
            case '=':
              if (varValue !== conditionValue) {
                pass = false
              }
              break
            case '!=':
              if (varValue === conditionValue) {
                pass = false
              }
              break
            case '>':
              if (Number(varValue) <= Number(conditionValue)) {
                pass = false
              }
              break
            case '<':
              if (Number(varValue) >= Number(conditionValue)) {
                pass = false
              }
              break
            case '>=':
              if (Number(varValue) < Number(conditionValue)) {
                pass = false
              }
              break
            case '<=':
              if (Number(varValue) > Number(conditionValue)) {
                pass = false
              }
              break
            case 'null':
              if (varValue !== 'null') {
                pass = false
              }
              break
          }
        }
      } else if (condition.type === 'exists') {
        const conditionValue = risuChatParser(condition.value, { chara: char })
        const val = risuChatParser(conditionValue, { chara: char })
        let da = chat.message
          .slice(0 - condition.depth)
          .map((v) => v.data)
          .join(' ')
        if (condition.type2 === 'strict') {
          pass = da.split(' ').includes(val)
        } else if (condition.type2 === 'loose') {
          pass = da.toLowerCase().includes(val.toLowerCase())
        } else if (condition.type2 === 'regex') {
          pass = getCompiledRegex(val, '').test(da)
        }
      }
      if (!pass) {
        break
      }
    }
    if (!pass) {
      continue
    }

    for (let index = 0; index < trigger.effect.length; index++) {
      const effect = trigger.effect[index]
      if (chargeTriggerEffectStep(triggerBudget, arg.signal, effect.type)) {
        return await awaitClientWriteOperation(clientOperation, buildResult())
      }
      if (!isFresh()) {
        return await awaitClientWriteOperation(clientOperation, buildResult())
      }
      if (mode === 'display' && !displayAllowList.includes(effect.type)) {
        continue
      }
      if (mode === 'request' && !requestAllowList.includes(effect.type)) {
        continue
      }

      if (effect && 'indent' in effect && typeof effect.indent === 'number' && effect.indent >= 0) {
        currentIndent = effect.indent
      } else if (!effect || !('indent' in effect)) {
        currentIndent = 0
      }

      switch (effect.type) {
        case 'setvar': {
          const effectValue = risuChatParser(effect.value, { chara: char })
          const varKey = risuChatParser(effect.var, { chara: char })
          let originalVar = Number(getVar(varKey))
          if (Number.isNaN(originalVar)) {
            originalVar = 0
          }
          let resultValue = ''
          switch (effect.operator) {
            case '=': {
              resultValue = effectValue
              break
            }
            case '+=': {
              resultValue = (originalVar + Number(effectValue)).toString()
              break
            }
            case '-=': {
              resultValue = (originalVar - Number(effectValue)).toString()
              break
            }
            case '*=': {
              resultValue = (originalVar * Number(effectValue)).toString()
              break
            }
            case '/=': {
              resultValue = (originalVar / Number(effectValue)).toString()
              break
            }
          }
          setVar(varKey, resultValue)
          break
        }
        case 'systemprompt': {
          const effectValue = risuChatParser(effect.value, { chara: char })
          additonalSysPrompt[effect.location] += effectValue + '\n\n'
          break
        }
        case 'impersonate': {
          const effectValue = risuChatParser(effect.value, { chara: char })
          if (effect.role === 'user') {
            chat.message.push({ role: 'user', data: effectValue })
          } else if (effect.role === 'char') {
            chat.message.push({ role: 'char', data: effectValue })
          }
          break
        }
        case 'command': {
          const effectValue = risuChatParser(effect.value, { chara: char })
          await awaitClientWriteOperation(clientOperation, processMultiCommand(effectValue))
          break
        }
        case 'stop':
        case 'v2StopPromptSending': {
          stopSending = true
          break
        }
        case 'runtrigger': {
          if (arg.recursiveCount < triggerBudget.maxRecursionDepth) {
            const recursiveCount = arg.recursiveCount + 1
            const r = await awaitClientWriteOperation(
              clientOperation,
              runTrigger(char, 'manual', {
                chat,
                recursiveCount,
                additonalSysPrompt,
                stopSending,
                manualName: effect.value,
                signal: arg.signal,
                triggerBudget,
                isFresh: arg.isFresh,
                deferLiveChatSideEffects: arg.deferLiveChatSideEffects,
              }),
            )
            if (r) {
              additonalSysPrompt = r.additonalSysPrompt
              chat = r.chat
              stopSending = r.stopSending
            }
          }
          break
        }
        case 'cutchat': {
          const start = Number(risuChatParser(effect.start, { chara: char }))
          const end = Number(risuChatParser(effect.end, { chara: char }))
          chat.message = chat.message.slice(start, end)
          break
        }
        case 'modifychat': {
          const index = Number(risuChatParser(effect.index, { chara: char }))
          const value = risuChatParser(effect.value, { chara: char })
          if (chat.message[index]) {
            chat.message[index].data = value
          }
          break
        }

        // low level access only
        case 'showAlert': {
          if (!trigger.lowLevelAccess) {
            break
          }

          if (arg.displayMode) {
            return
          }

          const effectValue = risuChatParser(effect.value, { chara: char })
          const inputVar = risuChatParser(effect.inputVar, { chara: char })

          switch (effect.alertType) {
            case 'normal': {
              alertNormal(effectValue)
              break
            }
            case 'error': {
              alertError(effectValue)
              break
            }
            case 'input': {
              const val = await awaitClientWriteOperation(clientOperation, alertInput(effectValue))
              setVar(inputVar, val)
              break
            }
            case 'select': {
              const val = await awaitClientWriteOperation(clientOperation, alertSelect(effectValue.split('§')))
              if (val === null) break
              setVar(inputVar, val)
            }
          }
          break
        }

        case 'sendAIprompt': {
          if (!trigger.lowLevelAccess) {
            break
          }
          sendAIprompt = true
          break
        }

        case 'runLLM': {
          if (!trigger.lowLevelAccess) {
            break
          }
          const effectValue = risuChatParser(effect.value, { chara: char })
          const varName = effect.inputVar
          let promptbody: OpenAIChat[] = parseChatML(effectValue)
          if (!promptbody) {
            promptbody = [{ role: 'user', content: effectValue }]
          }
          const result = await awaitClientWriteOperation(
            clientOperation,
            requestChatData(
              {
                formated: promptbody,
                bias: {},
                useStreaming: false,
                noMultiGen: true,
                ...(scriptModelOverrideProfileId(scriptModelOverridesForTrigger(trigger, char), 'scriptMain')
                  ? {
                      profileIdOverride: scriptModelOverrideProfileId(
                        scriptModelOverridesForTrigger(trigger, char),
                        'scriptMain',
                      ),
                      strictProfileIdOverride: true,
                    }
                  : {}),
              },
              'scriptMain',
            ),
          )

          if (result.type === 'fail' || result.type === 'streaming' || result.type === 'multiline') {
            setVar(varName, 'Error: ' + result.result)
          } else {
            setVar(varName, result.result)
          }

          break
        }

        case 'checkSimilarity': {
          if (!trigger.lowLevelAccess) {
            break
          }

          const processer = new HypaProcesser()
          const effectValue = risuChatParser(effect.value, { chara: char })
          const source = risuChatParser(effect.source, { chara: char })
          await awaitClientWriteOperation(clientOperation, processer.addText(effectValue.split('§')))
          const val = await awaitClientWriteOperation(clientOperation, processer.similaritySearch(source))
          setVar(effect.inputVar, val.join('§'))
          break
        }

        case 'extractRegex': {
          if (!trigger.lowLevelAccess) {
            break
          }

          const effectValue = risuChatParser(effect.value, { chara: char })
          const regex = getCompiledRegex(effect.regex, effect.flags)
          const regexResult = regex.exec(effectValue)
          const result = effect.result
            .replace(/\$[0-9]+/g, (match) => {
              const index = Number(match.slice(1))
              return regexResult?.[index] ?? ''
            })
            .replace(/\$&/g, regexResult?.[0] ?? '')
            .replace(/\$\$/g, '$')

          setVar(effect.inputVar, result)
          break
        }

        case 'runImgGen': {
          if (!trigger.lowLevelAccess) {
            break
          }

          const effectValue = risuChatParser(effect.value, { chara: char })
          const negValue = risuChatParser(effect.negValue, { chara: char })
          const gen = await awaitClientWriteOperation(
            clientOperation,
            generateAIImage(effectValue, char, negValue, 'inlay'),
          )
          if (!gen) {
            setVar(effect.inputVar, 'Error: Image generation failed')
            break
          }
          const imgHTML = new Image()
          imgHTML.src = gen
          const inlay = await awaitClientWriteOperation(clientOperation, writeInlayImage(imgHTML))
          const res = `{{inlay::${inlay}}}`
          setVar(effect.inputVar, res)
          break
        }

        case 'triggerlua': {
          const moduleOwner = getModuleTriggerOwner(trigger)
          const triggerCodeResult = await awaitClientWriteOperation(
            clientOperation,
            runScripted(effect.code, {
              lowLevelAccess: trigger.lowLevelAccess,
              mode: mode === 'manual' ? arg.manualName : mode,
              setVar: setVar,
              getVar: getVar,
              char: char,
              chat: chat,
              scriptModelOverrides: moduleOwner ? moduleOwner.scriptModelOverrides : char.scriptModelOverrides,
            }),
          )

          if (triggerCodeResult.stopSending) {
            stopSending = true
          }
          chat = triggerCodeResult.chat
          break
        }

        //V2 triggers
        case 'v2Header': {
          //Header for V2 triggers to identify the start of a new trigger
          break
        }
        case 'v2SetVar': {
          const effectValue =
            effect.valueType === 'value'
              ? risuChatParser(effect.value, { chara: char })
              : getVar(risuChatParser(effect.value, { chara: char }))
          const varKey = risuChatParser(effect.var, { chara: char })
          let originalVar = Number(getVar(varKey))
          if (Number.isNaN(originalVar)) {
            originalVar = 0
          }
          let resultValue = ''
          switch (effect.operator) {
            case '=': {
              resultValue = effectValue
              break
            }
            case '+=': {
              resultValue = (originalVar + Number(effectValue)).toString()
              break
            }
            case '-=': {
              resultValue = (originalVar - Number(effectValue)).toString()
              break
            }
            case '*=': {
              resultValue = (originalVar * Number(effectValue)).toString()
              break
            }
            case '/=': {
              resultValue = (originalVar / Number(effectValue)).toString()
              break
            }
            case '%=': {
              resultValue = (originalVar % Number(effectValue)).toString()
              break
            }
          }
          setVar(varKey, resultValue)
          break
        }
        case 'v2DeclareLocalVar': {
          const effectValue =
            effect.valueType === 'value'
              ? risuChatParser(effect.value, { chara: char })
              : getVar(risuChatParser(effect.value, { chara: char }))
          const varKey = risuChatParser(effect.var, { chara: char })
          const finalValue = effectValue === null || effectValue === undefined ? 'null' : effectValue
          declareLocalVar(varKey, finalValue, effect.indent)
          break
        }
        case 'v2If':
        case 'v2IfAdvanced': {
          const sourceValue =
            effect.type === 'v2If' || effect.sourceType === 'var'
              ? getVar(risuChatParser(effect.source, { chara: char }))
              : risuChatParser(effect.source, { chara: char })
          const targetValue =
            effect.targetType === 'value'
              ? risuChatParser(effect.target, { chara: char })
              : getVar(risuChatParser(effect.target, { chara: char }))
          let pass = false
          switch (effect.condition) {
            case '=': {
              if (!isNaN(Number(sourceValue)) && !isNaN(Number(targetValue))) {
                //to check like 1.0 = 1
                pass = Number(sourceValue) === Number(targetValue)
              } else {
                pass = sourceValue === targetValue
              }
              break
            }
            case '!=': {
              if (!isNaN(Number(sourceValue)) && !isNaN(Number(targetValue))) {
                //to check like 1.0 = 1
                pass = Number(sourceValue) !== Number(targetValue)
              } else {
                pass = sourceValue !== targetValue
              }
              break
            }
            case '>': {
              pass = Number(sourceValue) > Number(targetValue)
              break
            }
            case '<': {
              pass = Number(sourceValue) < Number(targetValue)
              break
            }
            case '>=': {
              pass = Number(sourceValue) >= Number(targetValue)
              break
            }
            case '<=': {
              pass = Number(sourceValue) <= Number(targetValue)
              break
            }
            case '∈': {
              try {
                pass = JSON.parse(targetValue).includes(sourceValue)
              } catch (error) {
                pass = false
              }
              break
            }
            case '∋': {
              try {
                pass = JSON.parse(sourceValue).includes(targetValue)
              } catch (error) {
                pass = false
              }
              break
            }
            case '∉': {
              try {
                pass = !JSON.parse(targetValue).includes(sourceValue)
              } catch (error) {
                pass = true
              }
              break
            }
            case '∌': {
              try {
                pass = !JSON.parse(sourceValue).includes(targetValue)
              } catch (error) {
                pass = true
              }
              break
            }
            case '≒': {
              const num1 = Number(sourceValue)
              const num2 = Number(targetValue)
              if (Number.isNaN(num1) || Number.isNaN(num2)) {
                pass =
                  sourceValue.toLocaleLowerCase().replace(/ /g, '') ===
                  targetValue.toLocaleLowerCase().replace(/ /g, '')
              } else {
                pass = Math.abs(num1 - num2) < 0.0001
              }
              break
            }
            case '≡': {
              if (targetValue === 'true') {
                pass = sourceValue === 'true' || sourceValue === '1'
              } else if (targetValue === 'false') {
                pass = !(sourceValue === 'true' || sourceValue === '1')
              } else {
                pass = sourceValue === targetValue
              }
            }
          }

          if (!pass) {
            let indent = effect.indent + 1
            for (; index < trigger.effect.length; index++) {
              const ef = trigger.effect[index] as triggerEffectV2
              if (ef.type === 'v2EndIndent' && indent === ef.indent) {
                const nextEf = trigger.effect[index + 1] as triggerEffectV2
                indent--
                if (nextEf?.type === 'v2Else' && nextEf?.indent === indent) {
                  index++
                }

                break
              }
            }
          }
          break
        }
        case 'v2Else': {
          //since if handles the else if the if is false, we can skip the else
          const indent = effect.indent + 1
          for (; index < trigger.effect.length; index++) {
            const ef = trigger.effect[index] as triggerEffectV2
            if (ef.type === 'v2EndIndent' && indent === ef.indent) {
              break
            }
          }
          break
        }
        case 'v2EndIndent': {
          if (effect.endOfLoop) {
            const indent = effect.indent - 1
            const originalIndex = index
            for (; index >= 0; index--) {
              const ef = trigger.effect[index] as triggerEffectV2
              if ((ef.type === 'v2Loop' || ef.type === 'v2LoopNTimes') && indent === ef.indent) {
                if (ef.type === 'v2LoopNTimes') {
                  let value =
                    ef.valueType === 'value'
                      ? risuChatParser(ef.value, { chara: char })
                      : getVar(risuChatParser(ef.value, { chara: char }))
                  let valueNum = Number(value)
                  if (Number.isNaN(valueNum)) {
                    valueNum = 0
                  }
                  tempVars[index + 'LoopNTimes'] = (tempVars[index + 'LoopNTimes'] ?? 0) + 1
                  if (tempVars[index + 'LoopNTimes'] >= valueNum) {
                    index = originalIndex
                  } else {
                    if (chargeTriggerLoopBack(triggerBudget, arg.signal, ef.type)) {
                      return await awaitClientWriteOperation(clientOperation, buildResult())
                    }
                    break
                  }
                } else if (chargeTriggerLoopBack(triggerBudget, arg.signal, ef.type)) {
                  return await awaitClientWriteOperation(clientOperation, buildResult())
                }

                break
              }
            }

            //this is for preventing lagging
            tempVars['loopTimes'] = (tempVars['loopTimes'] ?? 0) + 1
            if (tempVars['loopTimes'] > 100) {
              await awaitClientWriteOperation(clientOperation, sleepWithAbort(1, arg.signal, triggerBudget))
              tempVars['loopTimes'] = 0
              if (shouldStopTriggerExecution(triggerBudget, arg.signal, 'after v2 loop yield')) {
                return await awaitClientWriteOperation(clientOperation, buildResult())
              }
            }
          }

          clearLocalVarsAtIndent(effect.indent)

          break
        }
        case 'v2Loop':
        case 'v2LoopNTimes': {
          //Looping is handled by the v2EndIndent
          break
        }
        case 'v2BreakLoop': {
          for (; index < trigger.effect.length; index++) {
            const ef = trigger.effect[index] as triggerEffectV2
            if (ef.type === 'v2EndIndent' && ef.endOfLoop) {
              break
            }
          }
          break
        }
        case 'v2RunTrigger': {
          if (arg.recursiveCount < triggerBudget.maxRecursionDepth) {
            const recursiveCount = arg.recursiveCount + 1
            const r = await awaitClientWriteOperation(
              clientOperation,
              runTrigger(char, 'manual', {
                chat,
                recursiveCount,
                additonalSysPrompt,
                stopSending,
                manualName: effect.target,
                signal: arg.signal,
                triggerBudget,
                isFresh: arg.isFresh,
                deferLiveChatSideEffects: arg.deferLiveChatSideEffects,
              }),
            )
            if (r) {
              additonalSysPrompt = r.additonalSysPrompt
              chat = r.chat
              stopSending = r.stopSending
            }
          }
          break
        }
        case 'v2ConsoleLog': {
          const sourceValue =
            effect.sourceType === 'value'
              ? risuChatParser(effect.source, { chara: char })
              : getVar(risuChatParser(effect.source, { chara: char }))
          console.log(sourceValue)
          break
        }
        case 'v2StopTrigger': {
          index = trigger.effect.length
          break
        }
        case 'v2CutChat': {
          let start =
            effect.startType === 'value'
              ? Number(risuChatParser(effect.start, { chara: char }))
              : Number(getVar(risuChatParser(effect.start, { chara: char })))
          let end =
            effect.endType === 'value'
              ? Number(risuChatParser(effect.end, { chara: char }))
              : Number(getVar(risuChatParser(effect.end, { chara: char })))
          if (isNaN(start)) {
            start = 0
          }
          if (isNaN(end)) {
            end = chat.message.length
          }

          chat.message = chat.message.slice(start, end)
          break
        }
        case 'v2ModifyChat': {
          let index =
            effect.indexType === 'value'
              ? Number(risuChatParser(effect.index, { chara: char }))
              : Number(getVar(risuChatParser(effect.index, { chara: char })))
          let value =
            effect.valueType === 'value'
              ? risuChatParser(effect.value, { chara: char })
              : getVar(risuChatParser(effect.value, { chara: char }))
          if (chat.message[index]) {
            chat.message[index].data = value
          }
          break
        }
        case 'v2SystemPrompt': {
          let value =
            effect.valueType === 'value'
              ? risuChatParser(effect.value, { chara: char })
              : getVar(risuChatParser(effect.value, { chara: char }))
          additonalSysPrompt[effect.location] += value + '\n\n'
          break
        }
        case 'v2Impersonate': {
          let value =
            effect.valueType === 'value'
              ? risuChatParser(effect.value, { chara: char })
              : getVar(risuChatParser(effect.value, { chara: char }))
          if (effect.role === 'user') {
            chat.message.push({ role: 'user', data: value })
          } else if (effect.role === 'char') {
            chat.message.push({ role: 'char', data: value })
          }
          break
        }
        case 'v2Command': {
          let value =
            effect.valueType === 'value'
              ? risuChatParser(effect.value, { chara: char })
              : getVar(risuChatParser(effect.value, { chara: char }))
          await awaitClientWriteOperation(clientOperation, processMultiCommand(value))
          break
        }
        case 'v2SendAIprompt': {
          if (!trigger.lowLevelAccess) {
            break
          }
          sendAIprompt = true
          break
        }
        case 'v2ImgGen': {
          if (!trigger.lowLevelAccess) {
            break
          }
          let value =
            effect.valueType === 'value'
              ? risuChatParser(effect.value, { chara: char })
              : getVar(risuChatParser(effect.value, { chara: char }))
          let negValue =
            effect.negValueType === 'value'
              ? risuChatParser(effect.negValue, { chara: char })
              : getVar(risuChatParser(effect.negValue, { chara: char }))
          let gen = await awaitClientWriteOperation(clientOperation, generateAIImage(value, char, negValue, 'inlay'))
          if (!gen) {
            setVar(risuChatParser(effect.outputVar, { chara: char }), 'null')
            break
          }
          let imgHTML = new Image()
          imgHTML.src = gen
          let inlay = await awaitClientWriteOperation(clientOperation, writeInlayImage(imgHTML))
          let res = `{{inlay::${inlay}}}`
          setVar(risuChatParser(effect.outputVar, { chara: char }), res)
          break
        }
        case 'v2CheckSimilarity': {
          if (!trigger.lowLevelAccess) {
            break
          }
          let source =
            effect.sourceType === 'value'
              ? risuChatParser(effect.source, { chara: char })
              : getVar(risuChatParser(effect.source, { chara: char }))
          let value =
            effect.valueType === 'value'
              ? risuChatParser(effect.value, { chara: char })
              : getVar(risuChatParser(effect.value, { chara: char }))
          let processer = new HypaProcesser()
          await awaitClientWriteOperation(clientOperation, processer.addText(value.split('§')))
          let val = await awaitClientWriteOperation(clientOperation, processer.similaritySearch(source))
          setVar(risuChatParser(effect.outputVar, { chara: char }), val.join('§'))
          break
        }
        case 'v2RunLLM': {
          if (!trigger.lowLevelAccess) {
            break
          }
          let value =
            effect.valueType === 'value'
              ? risuChatParser(effect.value, { chara: char })
              : getVar(risuChatParser(effect.value, { chara: char }))
          let promptbody = parseChatML(value)
          if (!promptbody) {
            promptbody = [{ role: 'user', content: value }]
          }
          const modelRole = normalizeTriggerLLMMode(effect.model)
          let result = await awaitClientWriteOperation(
            clientOperation,
            requestChatData(
              {
                formated: promptbody,
                bias: {},
                useStreaming: effect.streaming ?? false,
                noMultiGen: true,
                ...(scriptModelOverrideProfileId(scriptModelOverridesForTrigger(trigger, char), modelRole)
                  ? {
                      profileIdOverride: scriptModelOverrideProfileId(
                        scriptModelOverridesForTrigger(trigger, char),
                        modelRole,
                      ),
                      strictProfileIdOverride: true,
                    }
                  : {}),
              },
              modelRole,
            ),
          )

          if (result.type === 'fail' || result.type === 'multiline') {
            setVar(risuChatParser(effect.outputVar, { chara: char }), 'null')
          } else if (result.type === 'streaming') {
            const text = await awaitClientWriteOperation(clientOperation, collectStreamingText(result.result))
            setVar(risuChatParser(effect.outputVar, { chara: char }), text)
          } else {
            setVar(risuChatParser(effect.outputVar, { chara: char }), result.result)
          }
          break
        }
        case 'v2ShowAlert': {
          if (arg.displayMode) {
            return
          }
          let value =
            effect.valueType === 'value'
              ? risuChatParser(effect.value, { chara: char })
              : getVar(risuChatParser(effect.value, { chara: char }))
          alertNormal(value)
          break
        }
        case 'v2ExtractRegex': {
          let value =
            effect.valueType === 'value'
              ? risuChatParser(effect.value, { chara: char })
              : getVar(risuChatParser(effect.value, { chara: char }))
          let regexValue =
            effect.regexType === 'value'
              ? risuChatParser(effect.regex, { chara: char })
              : getVar(risuChatParser(effect.regex, { chara: char }))
          let flagsValue =
            effect.flagsType === 'value'
              ? risuChatParser(effect.flags, { chara: char })
              : getVar(risuChatParser(effect.flags, { chara: char }))
          let regex = getCompiledRegex(regexValue, flagsValue)
          let regexResult = regex.exec(value)
          let resultValue =
            effect.resultType === 'value'
              ? risuChatParser(effect.result, { chara: char })
              : getVar(risuChatParser(effect.result, { chara: char }))

          let result = ''
          if (regexResult !== null) {
            result = resultValue
              .replace(/\$[0-9]+/g, (match) => {
                let index = Number(match.slice(1))
                return regexResult[index] || ''
              })
              .replace(/\$&/g, regexResult[0] || '')
              .replace(/\$\$/g, '$')
          } else {
            result = resultValue
              .replace(/\$[0-9]+/g, '')
              .replace(/\$&/g, '')
              .replace(/\$\$/g, '$')
          }

          setVar(risuChatParser(effect.outputVar, { chara: char }), result)
          break
        }
        case 'v2GetLastMessage': {
          setVar(
            risuChatParser(effect.outputVar, { chara: char }),
            chat.message[chat.message.length - 1]?.data ?? 'null',
          )
          break
        }
        case 'v2GetMessageAtIndex': {
          let index =
            effect.indexType === 'value'
              ? Number(risuChatParser(effect.index, { chara: char }))
              : Number(getVar(risuChatParser(effect.index, { chara: char })))
          setVar(risuChatParser(effect.outputVar, { chara: char }), chat.message[index]?.data ?? 'null')
          break
        }
        case 'v2GetMessageCount': {
          setVar(risuChatParser(effect.outputVar, { chara: char }), chat.message.length.toString())
          break
        }
        case 'v2ModifyLorebook': {
          materializeChar()
          char.globalLore = char.globalLore ?? []
          const target =
            effect.targetType === 'value'
              ? risuChatParser(effect.target, { chara: char })
              : getVar(risuChatParser(effect.target, { chara: char }))
          const value =
            effect.valueType === 'value'
              ? risuChatParser(effect.value, { chara: char })
              : getVar(risuChatParser(effect.value, { chara: char }))

          const index = char.globalLore.findIndex((v) => v[0] === target)
          if (index !== -1) {
            char.globalLore[index][1] = value
          }

          persistCharacterLorebookEdit(char)
          break
        }
        case 'v2GetLorebook': {
          char.globalLore = char.globalLore ?? []
          const target =
            effect.targetType === 'value'
              ? risuChatParser(effect.target, { chara: char })
              : getVar(risuChatParser(effect.target, { chara: char }))
          const index = char.globalLore.findIndex((v) => v[0] === target)
          setVar(risuChatParser(effect.outputVar, { chara: char }), index === -1 ? 'null' : char.globalLore[index][1])
          break
        }
        case 'v2GetLorebookCount': {
          char.globalLore = char.globalLore ?? []
          setVar(risuChatParser(effect.outputVar, { chara: char }), char.globalLore.length.toString())
          break
        }
        case 'v2GetLorebookEntry': {
          char.globalLore = char.globalLore ?? []
          let index =
            effect.indexType === 'value'
              ? Number(risuChatParser(effect.index, { chara: char }))
              : Number(getVar(risuChatParser(effect.index, { chara: char })))
          if (Number.isNaN(index)) {
            index = 0
          }
          setVar(risuChatParser(effect.outputVar, { chara: char }), char.globalLore[index]?.[1] ?? 'null')
          break
        }
        case 'v2SetLorebookActivation': {
          materializeChar()
          char.globalLore = char.globalLore ?? []
          let index =
            effect.indexType === 'value'
              ? Number(risuChatParser(effect.index, { chara: char }))
              : Number(getVar(risuChatParser(effect.index, { chara: char })))
          let value = effect.value
          char.globalLore[index][2] = value

          persistCharacterLorebookEdit(char)

          break
        }
        case 'v2GetLorebookIndexViaName': {
          char.globalLore = char.globalLore ?? []
          let name =
            effect.nameType === 'value'
              ? risuChatParser(effect.name, { chara: char })
              : getVar(risuChatParser(effect.name, { chara: char }))
          let index = char.globalLore.findIndex((v) => v[0] === name)
          setVar(risuChatParser(effect.outputVar, { chara: char }), index.toString())
          break
        }
        case 'v2Random': {
          let min =
            effect.minType === 'value'
              ? Number(risuChatParser(effect.min, { chara: char }))
              : Number(getVar(risuChatParser(effect.min, { chara: char })))
          let max =
            effect.maxType === 'value'
              ? Number(risuChatParser(effect.max, { chara: char }))
              : Number(getVar(risuChatParser(effect.max, { chara: char })))

          let output = Math.floor(Math.random() * (max - min + 1) + min)
          setVar(risuChatParser(effect.outputVar, { chara: char }), output.toString())
          break
        }
        case 'v2GetCharAt': {
          let source =
            effect.sourceType === 'value'
              ? risuChatParser(effect.source, { chara: char })
              : getVar(risuChatParser(effect.source, { chara: char }))
          let index =
            effect.indexType === 'value'
              ? Number(risuChatParser(effect.index, { chara: char }))
              : Number(getVar(risuChatParser(effect.index, { chara: char })))
          setVar(risuChatParser(effect.outputVar, { chara: char }), source[index] ?? 'null')
          break
        }
        case 'v2GetCharCount': {
          let source =
            effect.sourceType === 'value'
              ? risuChatParser(effect.source, { chara: char })
              : getVar(risuChatParser(effect.source, { chara: char }))
          setVar(risuChatParser(effect.outputVar, { chara: char }), source.length.toString())
          break
        }
        case 'v2ToLowerCase': {
          let source =
            effect.sourceType === 'value'
              ? risuChatParser(effect.source, { chara: char })
              : getVar(risuChatParser(effect.source, { chara: char }))
          setVar(risuChatParser(effect.outputVar, { chara: char }), source.toLowerCase())
          break
        }
        case 'v2ToUpperCase': {
          let source =
            effect.sourceType === 'value'
              ? risuChatParser(effect.source, { chara: char })
              : getVar(risuChatParser(effect.source, { chara: char }))
          setVar(risuChatParser(effect.outputVar, { chara: char }), source.toUpperCase())
          break
        }
        case 'v2SetCharAt': {
          let source =
            effect.sourceType === 'value'
              ? risuChatParser(effect.source, { chara: char })
              : getVar(risuChatParser(effect.source, { chara: char }))
          let index =
            effect.indexType === 'value'
              ? Number(risuChatParser(effect.index, { chara: char }))
              : Number(getVar(risuChatParser(effect.index, { chara: char })))
          let value =
            effect.valueType === 'value'
              ? risuChatParser(effect.value, { chara: char })
              : getVar(risuChatParser(effect.value, { chara: char }))
          const source2 = [...source]
          source2[index] = value
          setVar(risuChatParser(effect.outputVar, { chara: char }), source2.join(''))
          break
        }
        case 'v2SplitString': {
          let source =
            effect.sourceType === 'value'
              ? risuChatParser(effect.source, { chara: char })
              : getVar(risuChatParser(effect.source, { chara: char }))
          let delimiter: string

          if (effect.delimiterType === 'value') {
            delimiter = risuChatParser(effect.delimiter, { chara: char })
          } else if (effect.delimiterType === 'var') {
            delimiter = getVar(risuChatParser(effect.delimiter, { chara: char }))
          } else {
            delimiter = risuChatParser(effect.delimiter, { chara: char })
          }

          let result: string[]
          if (effect.delimiterType === 'regex') {
            try {
              const regexMatch = delimiter.match(/^\/(.+)\/([gimuy]*)$/)
              if (regexMatch) {
                const [, pattern, flags] = regexMatch
                const regex = getCompiledRegex(pattern, flags)
                result = source.split(regex)
              } else {
                const regex = getCompiledRegex(delimiter, '')
                result = source.split(regex)
              }
            } catch (error) {
              result = [source]
            }
          } else {
            result = source.split(delimiter)
          }

          setVar(risuChatParser(effect.outputVar, { chara: char }), JSON.stringify(result))
          break
        }
        case 'v2JoinArrayVar': {
          try {
            let varValue =
              effect.varType === 'value'
                ? risuChatParser(effect.var, { chara: char })
                : getVar(risuChatParser(effect.var, { chara: char }))
            let arr = JSON.parse(varValue)
            let delimiter =
              effect.delimiterType === 'value'
                ? risuChatParser(effect.delimiter, { chara: char })
                : getVar(risuChatParser(effect.delimiter, { chara: char }))
            setVar(risuChatParser(effect.outputVar, { chara: char }), arr.join(delimiter))
          } catch (error) {
            setVar(risuChatParser(effect.outputVar, { chara: char }), '')
          }
          break
        }
        case 'v2GetCharacterDesc': {
          setVar(risuChatParser(effect.outputVar, { chara: char }), char.desc)
          break
        }
        case 'v2SetCharacterDesc': {
          materializeChar()
          let value =
            effect.valueType === 'value'
              ? risuChatParser(effect.value, { chara: char })
              : getVar(risuChatParser(effect.value, { chara: char }))
          char.desc = value
          persistCharacterRowField(char, (owner) => {
            owner.desc = value
          })
          break
        }
        case 'v2GetPersonaDesc': {
          const personaOwner = getPersonaOwnerStateSnapshot()
          const selectedPersonaId = personaOwner?.selectedPersonaId
          const matches = selectedPersonaId
            ? (personaOwner?.personas.filter((persona) => persona.id === selectedPersonaId) ?? [])
            : []
          const savedPersonaPrompt = matches.length === 1 ? (matches[0].personaPrompt ?? '') : ''
          setVar(risuChatParser(effect.outputVar, { chara: char }), personaOwner?.personaPrompt || savedPersonaPrompt)
          break
        }
        case 'v2SetPersonaDesc': {
          const value =
            effect.valueType === 'value'
              ? risuChatParser(effect.value, { chara: char })
              : getVar(risuChatParser(effect.value, { chara: char }))
          setSelectedPersonaPromptFromTrigger(value)
          break
        }
        case 'v2GetReplaceGlobalNote': {
          setVar(risuChatParser(effect.outputVar, { chara: char }), char.replaceGlobalNote ?? '')
          break
        }
        case 'v2SetReplaceGlobalNote': {
          materializeChar()
          const value =
            effect.valueType === 'value'
              ? risuChatParser(effect.value, { chara: char })
              : getVar(risuChatParser(effect.value, { chara: char }))
          char.replaceGlobalNote = value
          persistCharacterRowField(char, (owner) => {
            owner.replaceGlobalNote = value
          })
          break
        }
        case 'v2MakeArrayVar': {
          const varName = risuChatParser(effect.var, { chara: char })
          if (varName.startsWith('[') && varName.endsWith(']')) {
            return
          }

          setVar(varName, '[]')
          break
        }
        case 'v2GetArrayVarLength': {
          try {
            const varName = risuChatParser(effect.var, { chara: char })
            let varValue = getVar(varName)
            let arr = JSON.parse(varValue)
            setVar(risuChatParser(effect.outputVar, { chara: char }), arr.length.toString())
          } catch (error) {
            setVar(risuChatParser(effect.outputVar, { chara: char }), '0')
          }
          break
        }
        case 'v2GetArrayVar': {
          try {
            const varName = risuChatParser(effect.var, { chara: char })
            let varValue = getVar(varName)
            let arr = JSON.parse(varValue)
            let index =
              effect.indexType === 'value'
                ? Number(risuChatParser(effect.index, { chara: char }))
                : Number(getVar(risuChatParser(effect.index, { chara: char })))
            setVar(risuChatParser(effect.outputVar, { chara: char }), arr[index] ?? 'null')
          } catch (error) {
            setVar(risuChatParser(effect.outputVar, { chara: char }), 'null')
          }
          break
        }
        case 'v2PushArrayVar': {
          try {
            const varName = risuChatParser(effect.var, { chara: char })
            let varValue = getVar(varName)
            let arr = JSON.parse(varValue)
            let value =
              effect.valueType === 'value'
                ? risuChatParser(effect.value, { chara: char })
                : getVar(risuChatParser(effect.value, { chara: char }))
            arr.push(value)
            setVar(varName, JSON.stringify(arr))
          } catch (error) {
            const varName = risuChatParser(effect.var, { chara: char })
            setVar(varName, '[]')
          }
          break
        }
        case 'v2PopArrayVar': {
          try {
            const varName = risuChatParser(effect.var, { chara: char })
            let varValue = getVar(varName)
            let arr = JSON.parse(varValue)
            setVar(risuChatParser(effect.outputVar, { chara: char }), arr.pop() ?? 'null')
            setVar(varName, JSON.stringify(arr))
          } catch (error) {
            const varName = risuChatParser(effect.var, { chara: char })
            setVar(varName, '[]')
            setVar(risuChatParser(effect.outputVar, { chara: char }), 'null')
          }
          break
        }
        case 'v2ShiftArrayVar': {
          try {
            const varName = risuChatParser(effect.var, { chara: char })
            let varValue = getVar(varName)
            let arr = JSON.parse(varValue)
            setVar(risuChatParser(effect.outputVar, { chara: char }), arr.shift() ?? 'null')
            setVar(varName, JSON.stringify(arr))
          } catch (error) {
            const varName = risuChatParser(effect.var, { chara: char })
            setVar(varName, '[]')
            setVar(risuChatParser(effect.outputVar, { chara: char }), 'null')
          }
          break
        }
        case 'v2UnshiftArrayVar': {
          try {
            const varName = risuChatParser(effect.var, { chara: char })
            let varValue = getVar(varName)
            let arr = JSON.parse(varValue)
            let value =
              effect.valueType === 'value'
                ? risuChatParser(effect.value, { chara: char })
                : getVar(risuChatParser(effect.value, { chara: char }))
            arr.unshift(value)
            setVar(varName, JSON.stringify(arr))
          } catch (error) {
            const varName = risuChatParser(effect.var, { chara: char })
            setVar(varName, '[]')
          }
          break
        }
        case 'v2SpliceArrayVar': {
          try {
            const varName = risuChatParser(effect.var, { chara: char })
            let varValue = getVar(varName)
            let arr = JSON.parse(varValue)
            let start =
              effect.startType === 'value'
                ? Number(risuChatParser(effect.start, { chara: char }))
                : Number(getVar(risuChatParser(effect.start, { chara: char })))
            let value =
              effect.itemType === 'value'
                ? risuChatParser(effect.item, { chara: char })
                : getVar(risuChatParser(effect.item, { chara: char }))
            arr.splice(start, 0, value)
            setVar(varName, JSON.stringify(arr))
          } catch (error) {
            const varName = risuChatParser(effect.var, { chara: char })
            setVar(varName, '[]')
          }
          break
        }
        case 'v2SliceArrayVar': {
          try {
            const varName = risuChatParser(effect.var, { chara: char })
            let varValue = getVar(varName)
            let arr = JSON.parse(varValue)
            let start =
              effect.startType === 'value'
                ? Number(risuChatParser(effect.start, { chara: char }))
                : Number(getVar(risuChatParser(effect.start, { chara: char })))
            let end =
              effect.endType === 'value'
                ? Number(risuChatParser(effect.end, { chara: char }))
                : Number(getVar(risuChatParser(effect.end, { chara: char })))

            setVar(risuChatParser(effect.outputVar, { chara: char }), JSON.stringify(arr.slice(start, end)))
          } catch (error) {
            setVar(risuChatParser(effect.outputVar, { chara: char }), '[]')
          }
          break
        }
        case 'v2GetIndexOfValueInArrayVar': {
          try {
            const varName = risuChatParser(effect.var, { chara: char })
            let varValue = getVar(varName)
            let arr = JSON.parse(varValue)
            let value =
              effect.valueType === 'value'
                ? risuChatParser(effect.value, { chara: char })
                : getVar(risuChatParser(effect.value, { chara: char }))
            setVar(risuChatParser(effect.outputVar, { chara: char }), arr.indexOf(value).toString())
          } catch (error) {
            setVar(risuChatParser(effect.outputVar, { chara: char }), '-1')
          }
          break
        }
        case 'v2RemoveIndexFromArrayVar': {
          try {
            const varName = risuChatParser(effect.var, { chara: char })
            let varValue = getVar(varName)
            let arr = JSON.parse(varValue)
            let index =
              effect.indexType === 'value'
                ? Number(risuChatParser(effect.index, { chara: char }))
                : Number(getVar(risuChatParser(effect.index, { chara: char })))
            arr.splice(index, 1)
            setVar(varName, JSON.stringify(arr))
          } catch (error) {
            const varName = risuChatParser(effect.var, { chara: char })
            setVar(varName, '[]')
          }
          break
        }
        case 'v2ConcatString': {
          let source1 =
            effect.source1Type === 'value'
              ? risuChatParser(effect.source1, { chara: char })
              : getVar(risuChatParser(effect.source1, { chara: char }))
          let source2 =
            effect.source2Type === 'value'
              ? risuChatParser(effect.source2, { chara: char })
              : getVar(risuChatParser(effect.source2, { chara: char }))
          setVar(risuChatParser(effect.outputVar, { chara: char }), source1 + source2)
          break
        }
        case 'v2GetLastUserMessage': {
          let lastUserMessage = chat.message
            .slice()
            .reverse()
            .find((v) => v.role === 'user')
          setVar(risuChatParser(effect.outputVar, { chara: char }), lastUserMessage?.data ?? 'null')
          break
        }
        case 'v2GetLastCharMessage': {
          let lastCharMessage = chat.message
            .slice()
            .reverse()
            .find((v) => v.role === 'char')
          setVar(risuChatParser(effect.outputVar, { chara: char }), lastCharMessage?.data ?? 'null')
          break
        }
        case 'v2GetFirstMessage': {
          setVar(
            risuChatParser(effect.outputVar, { chara: char }),
            chat.fmIndex === -1 ? char.firstMessage : char.alternateGreetings[chat.fmIndex],
          )
          break
        }
        case 'v2GetAlertInput': {
          if (arg.displayMode) {
            return
          }
          let value = await awaitClientWriteOperation(
            clientOperation,
            alertInput(
              effect.displayType === 'value'
                ? risuChatParser(effect.display, { chara: char })
                : getVar(risuChatParser(effect.display, { chara: char })),
            ),
          )
          setVar(risuChatParser(effect.outputVar, { chara: char }), value)
          break
        }
        case 'v2GetAlertSelect': {
          if (arg.displayMode) {
            return
          }
          const display =
            effect.displayType === 'value'
              ? risuChatParser(effect.display, { chara: char })
              : getVar(risuChatParser(effect.display, { chara: char }))
          const value =
            effect.valueType === 'value'
              ? risuChatParser(effect.value, { chara: char })
              : getVar(risuChatParser(effect.value, { chara: char }))
          const options = value.split('|')
          const result = await awaitClientWriteOperation(clientOperation, alertSelect(options, display))
          if (result === null) break
          setVar(risuChatParser(effect.outputVar, { chara: char }), result)
          break
        }
        case 'v2SetArrayVar': {
          const value =
            effect.valueType === 'value'
              ? risuChatParser(effect.value, { chara: char })
              : getVar(risuChatParser(effect.value, { chara: char }))
          const index =
            effect.indexType === 'value'
              ? Number(risuChatParser(effect.index, { chara: char }))
              : Number(getVar(risuChatParser(effect.index, { chara: char })))
          if (Number.isNaN(index)) {
            break
          }
          try {
            const varName = risuChatParser(effect.var, { chara: char })
            let varValue = getVar(varName)
            let arr = JSON.parse(varValue)
            arr[index] = value
            setVar(varName, JSON.stringify(arr))
          } catch (error) {}
          break
        }
        case 'v2GetDisplayState': {
          if (!arg.displayMode) {
            return
          }

          setVar(risuChatParser(effect.outputVar, { chara: char }), arg.displayData ?? 'null')
          break
        }
        case 'v2SetDisplayState': {
          if (!arg.displayMode) {
            return
          }
          arg.displayData =
            effect.valueType === 'value'
              ? risuChatParser(effect.value, { chara: char })
              : getVar(risuChatParser(effect.value, { chara: char }))
          break
        }
        case 'v2UpdateGUI': {
          refreshVariableOnlyGui()
          break
        }
        case 'v2UpdateChatAt': {
          reloadChatAt(effect.index)
          break
        }
        case 'v2Wait': {
          let value =
            effect.valueType === 'value'
              ? Number(risuChatParser(effect.value, { chara: char }))
              : Number(getVar(risuChatParser(effect.value, { chara: char })))
          await awaitClientWriteOperation(clientOperation, sleepWithAbort(value * 1000, arg.signal, triggerBudget))
          break
        }
        case 'v2GetRequestState': {
          if (!arg.displayMode) {
            return
          }
          const json = JSON.parse(arg.displayData) as OpenAIChat[]
          const index =
            effect.indexType === 'value'
              ? Number(risuChatParser(effect.index, { chara: char }))
              : Number(getVar(risuChatParser(effect.index, { chara: char })))
          const content = json?.[index]?.content ?? 'null'
          setVar(risuChatParser(effect.outputVar, { chara: char }), content)
          break
        }
        case 'v2SetRequestState': {
          if (!arg.displayMode) {
            return
          }
          const json = JSON.parse(arg.displayData) as OpenAIChat[]
          const index =
            effect.indexType === 'value'
              ? Number(risuChatParser(effect.index, { chara: char }))
              : Number(getVar(risuChatParser(effect.index, { chara: char })))
          const value =
            effect.valueType === 'value'
              ? risuChatParser(effect.value, { chara: char })
              : getVar(risuChatParser(effect.value, { chara: char }))
          json[index].content = value
          arg.displayData = JSON.stringify(json)
          break
        }
        case 'v2GetRequestStateRole': {
          if (!arg.displayMode) {
            return
          }
          const json = JSON.parse(arg.displayData) as OpenAIChat[]
          const index =
            effect.indexType === 'value'
              ? Number(risuChatParser(effect.index, { chara: char }))
              : Number(getVar(risuChatParser(effect.index, { chara: char })))
          const content = json?.[index]?.role ?? 'null'
          setVar(risuChatParser(effect.outputVar, { chara: char }), content)
          break
        }
        case 'v2SetRequestStateRole': {
          if (!arg.displayMode) {
            return
          }
          const json = JSON.parse(arg.displayData) as OpenAIChat[]
          const index =
            effect.indexType === 'value'
              ? Number(risuChatParser(effect.index, { chara: char }))
              : Number(getVar(risuChatParser(effect.index, { chara: char })))
          const value =
            effect.valueType === 'value'
              ? risuChatParser(effect.value, { chara: char })
              : getVar(risuChatParser(effect.value, { chara: char }))
          if (value === 'user' || value === 'assistant' || value === 'system') {
            json[index].role = value
          }
          arg.displayData = JSON.stringify(json)
          break
        }

        case 'v2GetRequestStateLength': {
          if (!arg.displayMode) {
            return
          }
          const json = JSON.parse(arg.displayData) as OpenAIChat[]
          setVar(risuChatParser(effect.outputVar, { chara: char }), json.length.toString())
          break
        }
        case 'v2QuickSearchChat': {
          const value =
            effect.valueType === 'value'
              ? risuChatParser(effect.value, { chara: char })
              : getVar(risuChatParser(effect.value, { chara: char }))
          const depth =
            effect.depthType === 'value'
              ? Number(risuChatParser(effect.depth, { chara: char }))
              : Number(getVar(risuChatParser(effect.depth, { chara: char })))
          const condition = effect.condition

          if (isNaN(depth)) {
            setVar(risuChatParser(effect.outputVar, { chara: char }), '0')
            break
          }
          let pass = false
          let da = chat.message
            .slice(0 - depth)
            .map((v) => v.data)
            .join(' ')
          if (condition === 'strict') {
            pass = da.split(' ').includes(value)
          } else if (condition === 'loose') {
            pass = da.toLowerCase().includes(value.toLowerCase())
          } else if (condition === 'regex') {
            pass = getCompiledRegex(value, '').test(da)
          }
          setVar(risuChatParser(effect.outputVar, { chara: char }), pass ? '1' : '0')
          break
        }
        case 'v2Tokenize': {
          const value =
            effect.valueType === 'value'
              ? risuChatParser(effect.value, { chara: char })
              : getVar(risuChatParser(effect.value, { chara: char }))
          setVar(
            risuChatParser(effect.outputVar, { chara: char }),
            (await awaitClientWriteOperation(clientOperation, tokenize(value))).toString(),
          )
          break
        }
        case 'v2GetAllLorebooks': {
          char.globalLore = char.globalLore ?? []
          const allPrompts: string[] = []
          for (const lore of char.globalLore) {
            if (lore && lore.content !== undefined) {
              allPrompts.push(lore.content)
            }
          }
          setVar(risuChatParser(effect.outputVar, { chara: char }), JSON.stringify(allPrompts))
          break
        }
        case 'v2GetLorebookByName': {
          char.globalLore = char.globalLore ?? []
          const name =
            effect.nameType === 'value'
              ? risuChatParser(effect.name, { chara: char })
              : getVar(risuChatParser(effect.name, { chara: char }))
          const regex = getCompiledRegex(name, 'i')
          const matchingIndices: number[] = []
          for (let i = 0; i < char.globalLore.length; i++) {
            const lore = char.globalLore[i]
            if (lore && lore.comment !== undefined && regex.test(lore.comment)) {
              matchingIndices.push(i)
            }
          }
          setVar(risuChatParser(effect.outputVar, { chara: char }), JSON.stringify(matchingIndices))
          break
        }
        case 'v2GetLorebookByIndex': {
          char.globalLore = char.globalLore ?? []
          let index =
            effect.indexType === 'value'
              ? Number(risuChatParser(effect.index, { chara: char }))
              : Number(getVar(risuChatParser(effect.index, { chara: char })))
          if (Number.isNaN(index) || index < 0 || index >= char.globalLore.length) {
            setVar(risuChatParser(effect.outputVar, { chara: char }), 'null')
          } else {
            const loreEntry = char.globalLore[index]
            if (loreEntry && loreEntry.content !== undefined) {
              setVar(risuChatParser(effect.outputVar, { chara: char }), loreEntry.content)
            } else {
              setVar(risuChatParser(effect.outputVar, { chara: char }), 'null')
            }
          }
          break
        }
        case 'v2CreateLorebook': {
          materializeChar()
          char.globalLore = char.globalLore ?? []
          const name =
            effect.nameType === 'value'
              ? risuChatParser(effect.name, { chara: char })
              : getVar(risuChatParser(effect.name, { chara: char }))
          const key =
            effect.keyType === 'value'
              ? risuChatParser(effect.key, { chara: char })
              : getVar(risuChatParser(effect.key, { chara: char }))
          const content =
            effect.contentType === 'value'
              ? risuChatParser(effect.content, { chara: char })
              : getVar(risuChatParser(effect.content, { chara: char }))
          const insertOrder =
            effect.insertOrderType === 'value'
              ? Number(risuChatParser(effect.insertOrder, { chara: char }))
              : Number(getVar(risuChatParser(effect.insertOrder, { chara: char })))

          char.globalLore.push({
            key: key,
            comment: name,
            content: content,
            mode: 'normal',
            insertorder: Number.isNaN(insertOrder) ? 100 : insertOrder,
            alwaysActive: false,
            secondkey: '',
            selective: false,
          })

          persistCharacterLorebookEdit(char)
          break
        }
        case 'v2ModifyLorebookByIndex': {
          materializeChar()
          char.globalLore = char.globalLore ?? []
          let index =
            effect.indexType === 'value'
              ? Number(risuChatParser(effect.index, { chara: char }))
              : Number(getVar(risuChatParser(effect.index, { chara: char })))

          if (Number.isNaN(index) || index < 0 || index >= char.globalLore.length || !char.globalLore[index]) {
            break
          }

          const currentLore = char.globalLore[index]
          let name =
            effect.nameType === 'value'
              ? risuChatParser(effect.name, { chara: char })
              : getVar(risuChatParser(effect.name, { chara: char }))
          name = name.replace(/{{slot}}/g, currentLore.comment || '')
          char.globalLore[index].comment = name

          let key =
            effect.keyType === 'value'
              ? risuChatParser(effect.key, { chara: char })
              : getVar(risuChatParser(effect.key, { chara: char }))
          key = key.replace(/{{slot}}/g, currentLore.key || '')
          char.globalLore[index].key = key

          let content =
            effect.contentType === 'value'
              ? risuChatParser(effect.content, { chara: char })
              : getVar(risuChatParser(effect.content, { chara: char }))
          content = content.replace(/{{slot}}/g, currentLore.content || '')
          char.globalLore[index].content = content

          let insertOrder =
            effect.insertOrderType === 'value'
              ? risuChatParser(effect.insertOrder, { chara: char })
              : getVar(risuChatParser(effect.insertOrder, { chara: char }))
          insertOrder = insertOrder.replace(/{{slot}}/g, (currentLore.insertorder || 100).toString())
          const insertOrderNum = Number(insertOrder)
          if (!Number.isNaN(insertOrderNum)) {
            char.globalLore[index].insertorder = insertOrderNum
          }

          persistCharacterLorebookEdit(char)
          break
        }
        case 'v2DeleteLorebookByIndex': {
          materializeChar()
          char.globalLore = char.globalLore ?? []
          let index =
            effect.indexType === 'value'
              ? Number(risuChatParser(effect.index, { chara: char }))
              : Number(getVar(risuChatParser(effect.index, { chara: char })))

          if (Number.isNaN(index) || index < 0 || index >= char.globalLore.length || !char.globalLore[index]) {
            break
          }

          char.globalLore.splice(index, 1)

          persistCharacterLorebookEdit(char)
          break
        }
        case 'v2GetLorebookCountNew': {
          char.globalLore = char.globalLore ?? []
          setVar(risuChatParser(effect.outputVar, { chara: char }), char.globalLore.length.toString())
          break
        }
        case 'v2SetLorebookAlwaysActive': {
          materializeChar()
          char.globalLore = char.globalLore ?? []
          let index =
            effect.indexType === 'value'
              ? Number(risuChatParser(effect.index, { chara: char }))
              : Number(getVar(risuChatParser(effect.index, { chara: char })))

          if (Number.isNaN(index) || index < 0 || index >= char.globalLore.length || !char.globalLore[index]) {
            break
          }

          char.globalLore[index].alwaysActive = effect.value

          persistCharacterLorebookEdit(char)
          break
        }
        case 'v2RegexTest': {
          try {
            const value =
              effect.valueType === 'value'
                ? risuChatParser(effect.value, { chara: char })
                : getVar(risuChatParser(effect.value, { chara: char }))
            const regexPattern =
              effect.regexType === 'value'
                ? risuChatParser(effect.regex, { chara: char })
                : getVar(risuChatParser(effect.regex, { chara: char }))
            const flags =
              effect.flagsType === 'value'
                ? risuChatParser(effect.flags, { chara: char })
                : getVar(risuChatParser(effect.flags, { chara: char }))
            const regex = getCompiledRegex(regexPattern, flags)
            const result = regex.test(value)
            setVar(risuChatParser(effect.outputVar, { chara: char }), result ? '1' : '0')
          } catch (error) {
            setVar(risuChatParser(effect.outputVar, { chara: char }), '0')
          }
          break
        }
        case 'v2GetAuthorNote': {
          setVar(risuChatParser(effect.outputVar, { chara: char }), chat.note ?? '')
          break
        }
        case 'v2SetAuthorNote': {
          const value =
            effect.valueType === 'value'
              ? risuChatParser(effect.value, { chara: char })
              : getVar(risuChatParser(effect.value, { chara: char }))
          chat.note = value

          if (!arg.displayMode && shouldApplyLiveChatSideEffects()) {
            // Capture before the projection write mutates the note, so the
            // scoped rollback restores the prior note (shared with the pass's
            // setVar snapshot).
            const noteRollback = captureScriptstateRollback()
            if (chat.id && applyChatMetadataOwnerPatch(char.chaId, chat.id, { note: value })) {
              dispatchUpdateChatNoteScoped(chat.id, value, noteRollback)
            }
          }
          break
        }
        case 'v2MakeDictVar': {
          if (effect.var.startsWith('{') && effect.var.endsWith('}')) {
            return
          }

          setVar(risuChatParser(effect.var, { chara: char }), '{}')
          break
        }
        case 'v2GetDictVar': {
          try {
            let varValue =
              effect.varType === 'value'
                ? risuChatParser(effect.var, { chara: char })
                : getVar(risuChatParser(effect.var, { chara: char }))
            let dict = JSON.parse(varValue)
            let key =
              effect.keyType === 'value'
                ? risuChatParser(effect.key, { chara: char })
                : getVar(risuChatParser(effect.key, { chara: char }))
            setVar(risuChatParser(effect.outputVar, { chara: char }), dict[key] ?? 'null')
          } catch (error) {
            setVar(risuChatParser(effect.outputVar, { chara: char }), 'null')
          }
          break
        }
        case 'v2SetDictVar': {
          try {
            const value =
              effect.valueType === 'value'
                ? risuChatParser(effect.value, { chara: char })
                : getVar(risuChatParser(effect.value, { chara: char }))
            const key =
              effect.keyType === 'value'
                ? risuChatParser(effect.key, { chara: char })
                : getVar(risuChatParser(effect.key, { chara: char }))

            if (effect.varType === 'value') {
              break
            }

            let varValue = getVar(risuChatParser(effect.var, { chara: char }))
            let dict = JSON.parse(varValue)
            dict[key] = value
            setVar(risuChatParser(effect.var, { chara: char }), JSON.stringify(dict))
          } catch (error) {
            if (effect.varType === 'var') {
              const value =
                effect.valueType === 'value'
                  ? risuChatParser(effect.value, { chara: char })
                  : getVar(risuChatParser(effect.value, { chara: char }))
              const key =
                effect.keyType === 'value'
                  ? risuChatParser(effect.key, { chara: char })
                  : getVar(risuChatParser(effect.key, { chara: char }))
              let dict = {}
              dict[key] = value
              setVar(risuChatParser(effect.var, { chara: char }), JSON.stringify(dict))
            }
          }
          break
        }
        case 'v2DeleteDictKey': {
          try {
            if (effect.varType === 'value') {
              break
            }

            let varValue = getVar(risuChatParser(effect.var, { chara: char }))
            let dict = JSON.parse(varValue)
            let key =
              effect.keyType === 'value'
                ? risuChatParser(effect.key, { chara: char })
                : getVar(risuChatParser(effect.key, { chara: char }))
            delete dict[key]
            setVar(risuChatParser(effect.var, { chara: char }), JSON.stringify(dict))
          } catch (error) {
            if (effect.varType === 'var') {
              setVar(risuChatParser(effect.var, { chara: char }), '{}')
            }
          }
          break
        }
        case 'v2HasDictKey': {
          try {
            let varValue =
              effect.varType === 'value'
                ? risuChatParser(effect.var, { chara: char })
                : getVar(risuChatParser(effect.var, { chara: char }))
            let dict = JSON.parse(varValue)
            let key =
              effect.keyType === 'value'
                ? risuChatParser(effect.key, { chara: char })
                : getVar(risuChatParser(effect.key, { chara: char }))
            setVar(risuChatParser(effect.outputVar, { chara: char }), Object.hasOwn(dict, key) ? '1' : '0')
          } catch (error) {
            setVar(risuChatParser(effect.outputVar, { chara: char }), '0')
          }
          break
        }
        case 'v2ClearDict': {
          if (effect.var.startsWith('{') && effect.var.endsWith('}')) {
            return
          }
          setVar(risuChatParser(effect.var, { chara: char }), '{}')
          break
        }
        case 'v2GetDictSize': {
          try {
            let varValue =
              effect.varType === 'value'
                ? risuChatParser(effect.var, { chara: char })
                : getVar(risuChatParser(effect.var, { chara: char }))
            let dict = JSON.parse(varValue)
            setVar(risuChatParser(effect.outputVar, { chara: char }), Object.keys(dict).length.toString())
          } catch (error) {
            setVar(risuChatParser(effect.outputVar, { chara: char }), '0')
          }
          break
        }
        case 'v2GetDictKeys': {
          try {
            let varValue =
              effect.varType === 'value'
                ? risuChatParser(effect.var, { chara: char })
                : getVar(risuChatParser(effect.var, { chara: char }))
            let dict = JSON.parse(varValue)
            let keys = Object.keys(dict)
            setVar(risuChatParser(effect.outputVar, { chara: char }), JSON.stringify(keys))
          } catch (error) {
            setVar(risuChatParser(effect.outputVar, { chara: char }), '[]')
          }
          break
        }
        case 'v2GetDictValues': {
          try {
            let varValue =
              effect.varType === 'value'
                ? risuChatParser(effect.var, { chara: char })
                : getVar(risuChatParser(effect.var, { chara: char }))
            let dict = JSON.parse(varValue)
            let values = Object.values(dict)
            setVar(risuChatParser(effect.outputVar, { chara: char }), JSON.stringify(values))
          } catch (error) {
            setVar(risuChatParser(effect.outputVar, { chara: char }), '[]')
          }
          break
        }
        case 'v2Calculate': {
          try {
            let expression =
              effect.expressionType === 'value'
                ? risuChatParser(effect.expression, { chara: char })
                : getVar(risuChatParser(effect.expression, { chara: char }))
            expression = expression.replace(/\$([a-zA-Z0-9_]+)/g, (_, varName) => {
              const varValue = getVar(varName)
              const parsed = parseFloat(varValue)
              return isNaN(parsed) ? '0' : parsed.toString()
            })

            const result = calcString(expression)
            setVar(risuChatParser(effect.outputVar, { chara: char }), result.toString())
          } catch (error) {
            setVar(risuChatParser(effect.outputVar, { chara: char }), '0')
          }
          break
        }
        case 'v2ReplaceString': {
          try {
            const source =
              effect.sourceType === 'value'
                ? risuChatParser(effect.source, { chara: char })
                : getVar(risuChatParser(effect.source, { chara: char }))
            const regexPattern =
              effect.regexType === 'value'
                ? risuChatParser(effect.regex, { chara: char })
                : getVar(risuChatParser(effect.regex, { chara: char }))
            const resultFormat =
              effect.resultType === 'value'
                ? risuChatParser(effect.result, { chara: char })
                : getVar(risuChatParser(effect.result, { chara: char }))
            const replacement =
              effect.replacementType === 'value'
                ? risuChatParser(effect.replacement, { chara: char })
                : getVar(risuChatParser(effect.replacement, { chara: char }))
            const flags =
              effect.flagsType === 'value'
                ? risuChatParser(effect.flags, { chara: char })
                : getVar(risuChatParser(effect.flags, { chara: char }))

            const regex = getCompiledRegex(regexPattern, flags)
            const result = source.replace(regex, (...args) => {
              const match = args[0]
              const groups = args.slice(1, -2)

              const targetGroupMatch = resultFormat.match(/^\$(\d+)$/)
              if (targetGroupMatch) {
                const targetIndex = Number(targetGroupMatch[1])
                if (targetIndex === 0) {
                  return replacement
                } else {
                  const targetGroup = groups[targetIndex - 1]
                  if (targetGroup) {
                    return match.replace(targetGroup, replacement)
                  }
                }
              }

              return resultFormat
                .replace(/\$[0-9]+/g, (placeholder) => {
                  const index = Number(placeholder.slice(1))
                  return index === 0 ? match : groups[index - 1] || ''
                })
                .replace(/\$&/g, match)
                .replace(/\$\$/g, '$')
            })
            setVar(risuChatParser(effect.outputVar, { chara: char }), result)
          } catch (error) {
            const source =
              effect.sourceType === 'value'
                ? risuChatParser(effect.source, { chara: char })
                : getVar(risuChatParser(effect.source, { chara: char }))
            setVar(risuChatParser(effect.outputVar, { chara: char }), source)
          }
          break
        }
        case 'v2Comment': {
          break
        }
      }
      if (shouldStopTriggerExecution(triggerBudget, arg.signal, `after effect ${effect.type}`)) {
        return await awaitClientWriteOperation(clientOperation, buildResult())
      }
    }
  }

  return await awaitClientWriteOperation(clientOperation, buildResult())
}
