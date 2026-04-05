import type * as monacoType from 'monaco-editor'

// ── Bash keywords from the Python file ──────────────────────────
const KEYWORDS = [
  'if','then','else','elif','fi','for','while','do','done',
  'case','esac','in','function','return','exit','break','continue',
  'local','readonly','export','declare','typeset','unset','shift',
  'set','source','trap','wait','echo','printf','read','exec',
  'eval','alias','unalias',
]

// ── Bash builtins from the Python file ──────────────────────────
const BUILTINS = [
  'cd','ls','pwd','mkdir','rmdir','rm','cp','mv','touch','cat',
  'grep','sed','awk','find','xargs','sort','uniq','wc','head',
  'tail','cut','tr','tee','curl','wget','ssh','scp','rsync',
  'git','docker','kubectl','helm','terraform','ansible',
  'systemctl','service','apt','apt-get','yum','dnf','pip',
  'pip3','python3','chmod','chown','chgrp','mount','umount',
  'df','du','ps','top','kill','killall','tar','zip','unzip',
  'gzip','gunzip','openssl','jq','yq','nc','nmap','ping',
  'iptables','ufw','nginx','apache2','mysql','psql','redis-cli','bc',
]

export function registerBashLanguage(monaco: typeof monacoType): void {
  // Register language
  monaco.languages.register({ id: 'bash', extensions: ['.sh','.bash','.zsh'], aliases: ['Bash','bash','sh'] })

  // Tokenizer — matches the Python regex patterns exactly
  monaco.languages.setMonarchTokensProvider('bash', {
    keywords: KEYWORDS,
    builtins: BUILTINS,
    tokenizer: {
      root: [
        // shebang line
        [/^#!.*$/, 'shebang'],
        // comments (must come before operators to capture #)
        [/#.*$/, 'comment'],
        // double-quoted strings
        [/"/, 'string.dq', '@string_dq'],
        // single-quoted strings
        [/'[^']*'/, 'string.sq'],
        // backtick strings
        [/`[^`]*`/, 'string.bt'],
        // variables: ${VAR} or $VAR or $1 $@ etc.
        [/\$\{[^}]*\}/, 'variable'],
        [/\$[A-Za-z_]\w*/, 'variable'],
        [/\$[0-9@#?*$!\-]/, 'variable'],
        // heredoc start (simple detection)
        [/<<[-]?['"]?[A-Za-z_]\w*['"]?/, 'string.heredoc'],
        // numbers
        [/\b[0-9]+\b/, 'number'],
        // flags like -f --verbose
        [/(^|\s)(-{1,2}[a-zA-Z][a-zA-Z0-9_-]*)/, ['', 'flag']],
        // operators
        [/&&|\|\||;;|>>|<<|[>|<&]/, 'operator'],
        // identifiers → keywords / builtins / default
        [/[a-zA-Z_][\w-]*/, {
          cases: {
            '@keywords': 'keyword',
            '@builtins': 'builtin',
            '@default':  'identifier',
          },
        }],
        // brackets
        [/[[\](){}]/, 'delimiter'],
        // assignment
        [/=/, 'operator.assignment'],
        // whitespace
        [/\s+/, ''],
      ],
      string_dq: [
        [/\$\{[^}]*\}/, 'variable'],
        [/\$[A-Za-z_]\w*/, 'variable'],
        [/\$[0-9@#?*$!\-]/, 'variable'],
        [/\\./, 'string.escape'],
        [/"/, 'string.dq', '@pop'],
        [/[^"$\\]+/, 'string.dq'],
      ],
    },
  })

  // Language configuration (brackets, comments, auto-close)
  monaco.languages.setLanguageConfiguration('bash', {
    comments: { lineComment: '#' },
    brackets: [['(', ')'], ['[', ']'], ['{', '}']],
    autoClosingPairs: [
      { open: '(', close: ')' },
      { open: '[', close: ']' },
      { open: '{', close: '}' },
      { open: '"', close: '"', notIn: ['string'] },
      { open: "'", close: "'", notIn: ['string'] },
      { open: '`', close: '`' },
    ],
    surroundingPairs: [
      { open: '(', close: ')' },
      { open: '[', close: ']' },
      { open: '{', close: '}' },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
    ],
    indentationRules: {
      increaseIndentPattern: /^.*\b(then|do|else|elif|\{|\()\s*$/,
      decreaseIndentPattern: /^\s*(fi|done|esac|else|elif|\}|\))\b/,
    },
  })
}

export function defineBashforgeTheme(monaco: typeof monacoType): void {
  monaco.editor.defineTheme('bashforge', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      // exact colors from Python BashForge
      { token: 'shebang',           foreground: '8b949e' },
      { token: 'comment',           foreground: '6e7681', fontStyle: 'italic' },
      { token: 'string.dq',        foreground: 'a5d6ff' },
      { token: 'string.sq',        foreground: 'a5d6ff' },
      { token: 'string.bt',        foreground: 'a5d6ff' },
      { token: 'string.heredoc',   foreground: 'a5d6ff' },
      { token: 'string.escape',    foreground: '79c0ff' },
      { token: 'variable',          foreground: 'ffa657' },
      { token: 'keyword',           foreground: 'bc8cff', fontStyle: 'bold' },
      { token: 'builtin',           foreground: '79c0ff' },
      { token: 'number',            foreground: '3fb950' },
      { token: 'flag',              foreground: 'd29922' },
      { token: 'operator',          foreground: 'f85149' },
      { token: 'operator.assignment', foreground: 'e6edf3' },
      { token: 'identifier',        foreground: 'e6edf3' },
      { token: 'delimiter',         foreground: 'e6edf3' },
    ],
    colors: {
      // Editor
      'editor.background':                    '#0d1117',
      'editor.foreground':                    '#e6edf3',
      'editor.lineHighlightBackground':       '#161b22',
      'editor.selectionBackground':           '#1f3a5f',
      'editor.inactiveSelectionBackground':   '#1f3a5f80',
      'editor.selectionHighlightBackground':  '#1f3a5f60',
      'editorCursor.foreground':              '#58a6ff',
      'editorLineNumber.foreground':          '#484f58',
      'editorLineNumber.activeForeground':    '#8b949e',
      'editorIndentGuide.background1':        '#21262d',
      'editorIndentGuide.activeBackground1':  '#30363d',
      // Find widget
      'editor.findMatchBackground':           '#264f78',
      'editor.findMatchHighlightBackground':  '#1f3a5f80',
      // Scrollbar
      'scrollbar.shadow':                     '#00000000',
      'scrollbarSlider.background':           '#30363d80',
      'scrollbarSlider.hoverBackground':      '#484f58',
      'scrollbarSlider.activeBackground':     '#6e7681',
      // Gutter
      'editorGutter.background':              '#0d1117',
      // Bracket match
      'editorBracketMatch.background':        '#1f3a5f',
      'editorBracketMatch.border':            '#58a6ff',
      // Widget (autocomplete etc.)
      'editorWidget.background':              '#161b22',
      'editorWidget.border':                  '#30363d',
      'editorSuggestWidget.background':       '#161b22',
      'editorSuggestWidget.border':           '#30363d',
      'editorSuggestWidget.selectedBackground': '#1f3a5f',
      // Input
      'input.background':                     '#0d1117',
      'input.border':                         '#30363d',
      'input.foreground':                     '#e6edf3',
      // Dropdown
      'dropdown.background':                  '#161b22',
      'dropdown.border':                      '#30363d',
    },
  })
}
