import { useEffect, useRef, useImperativeHandle, forwardRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";

export interface TerminalPanelHandle {
  write: (data: Uint8Array | string) => void;
  clear: () => void;
  focus: () => void;
  fit: () => void;
  getCols: () => number;
  getRows: () => number;
}

interface TerminalPanelProps {
  onInput: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
}

export const TerminalPanel = forwardRef<
  TerminalPanelHandle,
  TerminalPanelProps
>(function TerminalPanel({ onInput, onResize }, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const onInputRef = useRef(onInput);
  const onResizeRef = useRef(onResize);
  onInputRef.current = onInput;
  onResizeRef.current = onResize;

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      theme: {
        background: "#0a0e14", // BG_TERMINAL
        foreground: "#e6edf3",
        cursor: "#3fb950", // green cursor
        cursorAccent: "#0a0e14",
        selectionBackground: "#1f3a5f",
        black: "#0d1117",
        red: "#f85149",
        green: "#3fb950",
        yellow: "#d29922",
        blue: "#58a6ff",
        magenta: "#bc8cff",
        cyan: "#79c0ff",
        white: "#e6edf3",
        brightBlack: "#8b949e",
        brightRed: "#f85149",
        brightGreen: "#3fb950",
        brightYellow: "#d29922",
        brightBlue: "#58a6ff",
        brightMagenta: "#bc8cff",
        brightCyan: "#79c0ff",
        brightWhite: "#ffffff",
      },
      fontFamily: "'JetBrains Mono', Consolas, monospace",
      fontSize: 12,
      lineHeight: 1.5,
      cursorBlink: true,
      cursorStyle: "block",
      scrollback: 10000,
      convertEol: false,
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    const linksAddon = new WebLinksAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(linksAddon);
    term.open(containerRef.current);

    // Forward user input to backend
    term.onData((data) => onInputRef.current(data));

    // Forward resize to backend
    term.onResize(({ cols, rows }) => onResizeRef.current?.(cols, rows));

    termRef.current = term;
    fitAddonRef.current = fitAddon;

    // Wait for container to be fully laid out before fitting.
    // Use 250ms delay — enough for CSS flex to settle.
    // Then send a second resize after 1s as a safety net.
    const doFit = () => {
      fitAddon.fit();
      // Only notify backend if we got a real size (not 0 rows)
      if (term.rows > 3) {
        onResizeRef.current?.(term.cols, term.rows);
      }
    };
    setTimeout(doFit, 250);
    setTimeout(doFit, 1000);

    return () => {
      term.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
    };
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      write: (data) => termRef.current?.write(data),
      clear: () => termRef.current?.clear(),
      focus: () => termRef.current?.focus(),
      fit: () => fitAddonRef.current?.fit(),
      getCols: () => termRef.current?.cols ?? 80,
      getRows: () => termRef.current?.rows ?? 24,
    }),
    [],
  );

  return (
    <div
      ref={containerRef}
      className="xterm-container"
      style={{ flex: 1 }}
      onClick={() => termRef.current?.focus()}
    />
  );
});
