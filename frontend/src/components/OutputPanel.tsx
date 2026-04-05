import {
  useEffect,
  useRef,
  useImperativeHandle,
  forwardRef,
  useCallback,
} from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";

export interface OutputPanelHandle {
  write: (data: Uint8Array | string) => void;
  writeln: (
    text: string,
    style?: "info" | "success" | "error" | "warn" | "system",
  ) => void;
  clear: () => void;
  focus: () => void;
  fit: () => void;
  setInputCb: (cb: ((data: string) => void) | null) => void;
}

interface OutputPanelProps {
  isRunning: boolean;
}

// ANSI color codes matching Python FG_ colors
const C = {
  reset: "\x1b[0m",
  info: "\x1b[38;2;121;192;255m", // FG_CYAN    #79c0ff
  success: "\x1b[38;2;63;185;80m", // FG_GREEN   #3fb950
  error: "\x1b[38;2;248;81;73m", // FG_RED     #f85149
  warn: "\x1b[38;2;210;153;34m", // FG_YELLOW  #d29922
  system: "\x1b[38;2;110;118;129m", // FG_COMMENT #6e7681
  dim: "\x1b[38;2;139;148;158m", // FG_DIM     #8b949e
};

export const OutputPanel = forwardRef<OutputPanelHandle, OutputPanelProps>(
  function OutputPanel({ isRunning }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const termRef = useRef<Terminal | null>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);
    const inputCbRef = useRef<((data: string) => void) | null>(null);
    const disposables = useRef<Array<{ dispose(): void }>>([]);

    // Init xterm
    useEffect(() => {
      if (!containerRef.current) return;

      const term = new Terminal({
        theme: {
          background: "#010409", // BG_OUTPUT
          foreground: "#e6edf3", // FG_DEFAULT
          cursor: "#79c0ff",
          cursorAccent: "#010409",
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
        cursorStyle: "bar",
        scrollback: 5000,
        convertEol: true,
        allowProposedApi: true,
        disableStdin: false,
      });

      const fitAddon = new FitAddon();
      const linksAddon = new WebLinksAddon();
      term.loadAddon(fitAddon);
      term.loadAddon(linksAddon);
      term.open(containerRef.current);

      // Input forwarding — only active when script is running
      const d = term.onData((data) => {
        inputCbRef.current?.(data);
      });
      disposables.current = [d];

      termRef.current = term;
      fitAddonRef.current = fitAddon;

      // Show welcome message
      term.writeln(`${C.info}  Script output will appear here.${C.reset}`);
      term.writeln(
        `${C.dim}  Press Ctrl+Enter or click ▶ Run to execute your script.${C.reset}`,
      );
      term.writeln("");

      // Wait for layout to settle before measuring
      setTimeout(() => fitAddon.fit(), 250);
      setTimeout(() => fitAddon.fit(), 1000);

      return () => {
        disposables.current.forEach((d) => d.dispose());
        term.dispose();
        termRef.current = null;
        fitAddonRef.current = null;
      };
    }, []);

    // When run stops, write separator
    const prevRunning = useRef(false);
    useEffect(() => {
      if (prevRunning.current && !isRunning) {
        // Script just finished — separator already written by script_done handler
      }
      prevRunning.current = isRunning;
    }, [isRunning]);

    // Expose handle
    useImperativeHandle(
      ref,
      () => ({
        write: (data) => {
          termRef.current?.write(data);
        },
        writeln: (text, style) => {
          const prefix = style ? C[style] : "";
          termRef.current?.writeln(`${prefix}${text}${style ? C.reset : ""}`);
        },
        clear: () => {
          termRef.current?.clear();
          termRef.current?.writeln(`${C.info}  Output cleared.${C.reset}`);
          termRef.current?.writeln("");
        },
        focus: () => termRef.current?.focus(),
        fit: () => fitAddonRef.current?.fit(),
        setInputCb: (cb) => {
          inputCbRef.current = cb;
        },
      }),
      [],
    );

    return (
      <div
        ref={containerRef}
        className="xterm-container"
        style={{ flex: 1 }}
        onClick={() => isRunning && termRef.current?.focus()}
      />
    );
  },
);
