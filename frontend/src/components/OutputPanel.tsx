import { useEffect, useRef, useImperativeHandle, forwardRef } from 'react'
import { Terminal }      from '@xterm/xterm'
import { FitAddon }      from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'

export interface OutputPanelHandle {
  write:      (data: Uint8Array | string) => void
  writeln:    (text: string, style?: 'info' | 'success' | 'error' | 'warn' | 'system') => void
  clear:      () => void
  focus:      () => void
  fit:        () => void
  setInputCb: (cb: ((data: string) => void) | null) => void
}

interface OutputPanelProps { isRunning: boolean }

const C = {
  reset:   '\x1b[0m',
  info:    '\x1b[38;2;121;192;255m',
  success: '\x1b[38;2;63;185;80m',
  error:   '\x1b[38;2;248;81;73m',
  warn:    '\x1b[38;2;210;153;34m',
  system:  '\x1b[38;2;110;118;129m',
  dim:     '\x1b[38;2;139;148;158m',
}

export const OutputPanel = forwardRef<OutputPanelHandle, OutputPanelProps>(
  function OutputPanel({ isRunning: _ }, ref) {
    const containerRef = useRef<HTMLDivElement>(null)
    const termRef      = useRef<Terminal | null>(null)
    const fitAddonRef  = useRef<FitAddon | null>(null)
    const inputCbRef   = useRef<((data: string) => void) | null>(null)

    useEffect(() => {
      const container = containerRef.current
      if (!container) return

      const term = new Terminal({
        theme: {
          background: '#010409', foreground: '#e6edf3',
          cursor: '#79c0ff', cursorAccent: '#010409',
          selectionBackground: '#1f3a5f',
          black: '#0d1117', red: '#f85149',    green: '#3fb950',
          yellow: '#d29922', blue: '#58a6ff',   magenta: '#bc8cff',
          cyan: '#79c0ff',  white: '#e6edf3',
          brightBlack: '#8b949e', brightRed: '#f85149',
          brightGreen: '#3fb950', brightYellow: '#d29922',
          brightBlue: '#58a6ff',  brightMagenta: '#bc8cff',
          brightCyan: '#79c0ff',  brightWhite: '#ffffff',
        },
        fontFamily:  "'JetBrains Mono', Consolas, 'Courier New', monospace",
        fontSize:    13,
        lineHeight:  1.4,
        cursorBlink: true,
        cursorStyle: 'bar',
        scrollback:  5000,
        convertEol:  true,
        allowProposedApi: true,
        disableStdin: false,
      })

      const fitAddon   = new FitAddon()
      const linksAddon = new WebLinksAddon()
      term.loadAddon(fitAddon)
      term.loadAddon(linksAddon)
      term.open(container)

      const d = term.onData(data => inputCbRef.current?.(data))

      termRef.current    = term
      fitAddonRef.current = fitAddon

      // Welcome text
      term.writeln(`${C.info}  Script output will appear here.${C.reset}`)
      term.writeln(`${C.dim}  Ctrl+Enter or ▶ Run to execute your script.${C.reset}`)
      term.writeln('')

      // ResizeObserver for reliable initial fit
      const ro = new ResizeObserver((entries) => {
        const { width, height } = entries[0]?.contentRect ?? {}
        if (!width || !height || height < 10) return
        try { fitAddon.fit() } catch {}
      })
      ro.observe(container)
      setTimeout(() => { try { fitAddon.fit() } catch {} }, 400)

      return () => {
        d.dispose()
        ro.disconnect()
        term.dispose()
        termRef.current    = null
        fitAddonRef.current = null
      }
    }, [])

    useEffect(() => {
      const handler = () => { try { fitAddonRef.current?.fit() } catch {} }
      window.addEventListener('resize', handler)
      return () => window.removeEventListener('resize', handler)
    }, [])

    useImperativeHandle(ref, () => ({
      write:   data  => termRef.current?.write(data),
      writeln: (text, style) => {
        const p = style ? C[style] : ''
        termRef.current?.writeln(`${p}${text}${style ? C.reset : ''}`)
      },
      clear: () => {
        termRef.current?.clear()
        termRef.current?.writeln(`${C.info}  Output cleared.${C.reset}`)
        termRef.current?.writeln('')
      },
      focus:      ()  => termRef.current?.focus(),
      fit:        ()  => { try { fitAddonRef.current?.fit() } catch {} },
      setInputCb: cb  => { inputCbRef.current = cb },
    }), [])

    return (
      <div
        ref={containerRef}
        className="xterm-container"
        style={{ flex: 1 }}
        onClick={() => termRef.current?.focus()}
      />
    )
  },
)
