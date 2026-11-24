import * as monaco from 'monaco-editor/editor/editor.api'
import { javascriptDefaults, ScriptTarget } from 'monaco-editor/languages/features/typescript/register'
import 'monaco-editor/languages/definitions/javascript/register'
import 'monaco-editor/editor/contrib/suggest/browser/suggestController'
import 'monaco-editor/editor/contrib/hover/browser/hoverContribution'
import 'monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import TypeScriptWorker from 'monaco-editor/language/typescript/ts.worker?worker'

self.MonacoEnvironment = { getWorker: (_, label) => ['typescript', 'javascript'].includes(label) ? new TypeScriptWorker() : new EditorWorker() }

export function createFunctionEditor(host, value, run) {
  const defaults = javascriptDefaults
  defaults.setCompilerOptions({ allowNonTsExtensions: true, target: ScriptTarget.ES2020, checkJs: false })
  const extraLib = defaults.addExtraLib(`declare namespace GC.Spread.CalcEngine.Functions {
    class Function {
      constructor(name: string, minArgs?: number, maxArgs?: number, description?: {description?: string; parameters?: {name: string}[]});
      name: string; typeName: string; minArgs: number; maxArgs: number;
      toJSON(): Record<string, any>;
      fromJSON(settings: Record<string, any>): void;
      evaluate(...args: any[]): any;
      acceptsArray(argIndex: number): boolean;
      acceptsError(argIndex: number): boolean;
      acceptsMissingArgument(argIndex: number): boolean;
      acceptsReference(argIndex: number): boolean;
    }
  }`, 'file:///spreadjs-function.d.ts')
  const model = monaco.editor.createModel(value, 'javascript')
  const editor = monaco.editor.create(host, {
    model, theme: 'vs', automaticLayout: true, fontFamily: 'Consolas, "Courier New", monospace', fontSize: 13,
    lineHeight: 23, minimap: { enabled: false }, padding: { top: 18, bottom: 20 }, scrollBeyondLastLine: false,
    tabSize: 2, wordWrap: 'on', lineNumbersMinChars: 3, renderLineHighlight: 'gutter',
    ariaLabel: 'Function 代码编辑器', fixedOverflowWidgets: true,
  })
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, run)
  const touchInput = window.matchMedia('(any-pointer: coarse)')
  let currentFontSize
  const adaptType = () => {
    if (!host.clientWidth) return
    const fontSize = touchInput.matches || host.clientWidth < 480 ? 16 : 13
    if (fontSize === currentFontSize) return
    currentFontSize = fontSize
    editor.updateOptions({ fontSize, lineHeight: fontSize === 16 ? 26 : 23, lineNumbersMinChars: fontSize === 16 ? 2 : 3 })
  }
  const sizeObserver = new ResizeObserver(adaptType)
  sizeObserver.observe(host)
  touchInput.addEventListener('change', adaptType)
  adaptType()
  const layoutSubscription = { dispose() { sizeObserver.disconnect(); touchInput.removeEventListener('change', adaptType) } }
  return { editor, model, extraLib, layoutSubscription }
}
