import { useEffect, useRef, useImperativeHandle, forwardRef } from 'react'
import { Terminal }      from '@xterm/xterm'
import { FitAddon }      from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'

export interface TerminalPanelHandle {
  write:   (data: Uint8Array | string) => void
  clear:   () => void
  focus:   () => void
  fit:     () => void
  getCols: () => number
  getRows: () => number
}

interface TerminalPanelProps {
  onInput:   (data: string) => void
  onResize?: (cols: number, rows: number) => void
}

export const TerminalPanel = forwardRef<TerminalPanelHandle, TerminalPanelProps>(
  function TerminalPanel({ onInput, onResize }, ref) {
    const containerRef = useRef<HTMLDivElement>(null)
    const termRef      = useRef<Terminal | null>(null)
    const fitAddonRef  = useRef<FitAddon | null>(null)
    const onInputRef   = useRef(onInput)
    const onResizeRef  = useRef(onResize)
    onInputRef.current  = onInput
    onResizeRef.current = onResize

    useEffect(() => {
      const container = containerRef.current
      if (!container) return

      const term = new Terminal({
        theme: {
          background:          '#0a0e14',
          foreground:          '#e6edf3',
          cursor:              '#3fb950',
          cursorAccent:        '#0a0e14',
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
        letterSpacing: 0,
        cursorBlink: true,
        cursorStyle: 'block',
        scrollback:  10000,
        convertEol:  false,
        allowProposedApi: true,
      })

      const fitAddon   = new FitAddon()
      const linksAddon = new WebLinksAddon()
      term.loadAddon(fitAddon)
      term.loadAddon(linksAddon)
      term.open(container)

      term.onData(data => onInputRef.current(data))
      term.onResize(({ cols, rows }) => {
        if (rows > 2) onResizeRef.current?.(cols, rows)
      })

      termRef.current    = term
      fitAddonRef.current = fitAddon

      // Use ResizeObserver — fires when the container ACTUALLY gets its pixel size.
      // This is the correct way; setTimeout is a hack that races with layout.
      let fitted = false
      const ro = new ResizeObserver((entries) => {
        const entry = entries[0]
        if (!entry) return
        const { width, height } = entry.contentRect
        if (width < 10 || height < 10) return   // still zero, keep waiting
        try {
          fitAddon.fit()
          if (term.rows > 2) {
            onResizeRef.current?.(term.cols, term.rows)
            fitted = true
          }
        } catch { /* fitAddon not ready yet */ }
      })
      ro.observe(container)

      // Safety net: if ResizeObserver fires but FitAddon wasn't ready yet
      const safetyTimer = setTimeout(() => {
        if (!fitted) {
          try {
            fitAddon.fit()
            if (term.rows > 2) onResizeRef.current?.(term.cols, term.rows)
          } catch { /* ignore */ }
        }
      }, 500)

      return () => {
        ro.disconnect()
        clearTimeout(safetyTimer)
        term.dispose()
        termRef.current    = null
        fitAddonRef.current = null
      }
    }, [])

    // Re-fit on window resize
    useEffect(() => {
      const handler = () => {
        try { fitAddonRef.current?.fit() } catch { /* ignore */ }
      }
      window.addEventListener('resize', handler)
      return () => window.removeEventListener('resize', handler)
    }, [])

    useImperativeHandle(ref, () => ({
      write:   data => termRef.current?.write(data),
      clear:   ()   => termRef.current?.clear(),
      focus:   ()   => termRef.current?.focus(),
      fit:     ()   => { try { fitAddonRef.current?.fit() } catch {} },
      getCols: ()   => termRef.current?.cols ?? 80,
      getRows: ()   => termRef.current?.rows ?? 24,
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
