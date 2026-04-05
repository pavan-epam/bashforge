import { useEffect, useRef, useCallback } from 'react'
import MonacoEditor, { OnMount, BeforeMount } from '@monaco-editor/react'
import type * as monacoType from 'monaco-editor'
import { registerBashLanguage, defineBashforgeTheme } from '../monaco/bashLanguage'
import type { FileTab, CursorPosition } from '../types'

interface EditorPanelProps {
  activeTab:           FileTab | null
  onContentChange:     (content: string) => void
  onCursorChange:      (pos: CursorPosition) => void
  onRun:               () => void
  onSave:              () => void
  editorRef:           React.MutableRefObject<monacoType.editor.IStandaloneCodeEditor | null>
  width:               number
}

export function EditorPanel({
  activeTab,
  onContentChange,
  onCursorChange,
  onRun,
  onSave,
  editorRef,
  width,
}: EditorPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null)

  const beforeMount: BeforeMount = useCallback((monaco) => {
    defineBashforgeTheme(monaco)
    registerBashLanguage(monaco)
  }, [])

  const onMount: OnMount = useCallback((editor, monaco) => {
    editorRef.current = editor

    // ── Register keyboard shortcuts (matching Python exactly) ──────
    // Ctrl+Enter → Run
    editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter,
      () => onRun(),
      '',
    )

    // Ctrl+S → Save
    editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
      () => onSave(),
      '',
    )

    // Ctrl+/ → Toggle comment (Monaco built-in)
    editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.Slash,
      () => editor.trigger('keyboard', 'editor.action.commentLine', null),
    )

    // Ctrl+D → Duplicate line down (matching Python _dup_line)
    editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyD,
      () => editor.trigger('keyboard', 'editor.action.copyLinesDownAction', null),
    )

    // Ctrl+F → Open find (Monaco built-in find widget)
    // Already handled by Monaco natively

    // Ctrl+H → Open find+replace
    // Already handled by Monaco natively

    // Cursor position updates
    editor.onDidChangeCursorPosition((e) => {
      onCursorChange({ line: e.position.lineNumber, col: e.position.column })
    })

    // Initial cursor position
    onCursorChange({ line: 1, col: 1 })

    // Focus editor
    editor.focus()
  }, [onRun, onSave, onCursorChange, editorRef])

  // Update editor content when active tab changes
  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    const newValue = activeTab?.content ?? ''
    // Only set if different to avoid cursor jump
    if (editor.getValue() !== newValue) {
      editor.setValue(newValue)
    }
  }, [activeTab?.id, activeTab?.content, editorRef])

  // Resize editor when width changes
  useEffect(() => {
    editorRef.current?.layout()
  }, [width, editorRef])

  return (
    <div
      ref={containerRef}
      style={{ flex: 1, overflow: 'hidden', background: 'var(--bg-editor)' }}
    >
      <MonacoEditor
        height="100%"
        language="bash"
        theme="bashforge"
        value={activeTab?.content ?? ''}
        beforeMount={beforeMount}
        onMount={onMount}
        onChange={(value) => onContentChange(value ?? '')}
        options={{
          fontFamily:        "'JetBrains Mono', Consolas, 'Courier New', monospace",
          fontSize:           13,
          lineHeight:         22,
          fontLigatures:      true,
          wordWrap:          'off',
          minimap:           { enabled: false },
          scrollBeyondLastLine: false,
          smoothScrolling:   true,
          cursorBlinking:    'smooth',
          cursorSmoothCaretAnimation: 'on',
          renderLineHighlight: 'line',
          lineNumbers:       'on',
          renderWhitespace:  'selection',
          tabSize:            4,
          insertSpaces:       true,
          detectIndentation:  false,
          autoClosingBrackets: 'languageDefined',
          autoClosingQuotes:  'languageDefined',
          formatOnType:       false,
          formatOnPaste:      false,
          suggestOnTriggerCharacters: true,
          quickSuggestions:  { other: false, comments: false, strings: false },
          parameterHints:    { enabled: false },
          hover:             { enabled: true },
          scrollbar: {
            vertical:              'visible',
            horizontal:            'visible',
            verticalScrollbarSize:   8,
            horizontalScrollbarSize: 8,
          },
          overviewRulerBorder: false,
          overviewRulerLanes:  0,
          hideCursorInOverviewRuler: true,
          padding:            { top: 8, bottom: 8 },
          glyphMargin:        false,
        }}
      />
    </div>
  )
}
