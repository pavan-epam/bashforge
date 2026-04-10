// main.go — bash WebSocket-to-PTY bridge for BashForge sandbox pods
package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"github.com/creack/pty"
	"github.com/gorilla/websocket"
)

const (
	ChTerminal = 0x01
	ChScript   = 0x02
)

var (
	wsToken   = os.Getenv("WS_TOKEN")
	homeDir   = "/home/bashuser"
	workspace = "/home/bashuser/workspace"
	upgrader  = websocket.Upgrader{
		CheckOrigin:     func(r *http.Request) bool { return true },
		ReadBufferSize:  4096,
		WriteBufferSize: 4096,
	}
)

type CtrlMsg struct {
	Type    string   `json:"type"`
	Token   string   `json:"token,omitempty"`
	Path    string   `json:"path,omitempty"`
	Dir     string   `json:"dir,omitempty"`
	Name    string   `json:"name,omitempty"`
	Content string   `json:"content,omitempty"`
	Args    []string `json:"args,omitempty"`
	Cols    uint16   `json:"cols,omitempty"`
	Rows    uint16   `json:"rows,omitempty"`
}

type FileInfo struct {
	Name     string `json:"name"`
	Path     string `json:"path"`
	Size     int64  `json:"size"`
	Modified int64  `json:"modified"`
	IsDir    bool   `json:"is_dir"`
}

type Session struct {
	conn      *websocket.Conn
	mu        sync.Mutex
	termPty   *os.File
	termCmd   *exec.Cmd
	scriptPty *os.File
	scriptCmd *exec.Cmd
	scriptMu  sync.Mutex
}

func (s *Session) send(msgType int, data []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.conn.WriteMessage(msgType, data)
}

func (s *Session) sendJSON(v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return s.send(websocket.TextMessage, b)
}

func (s *Session) sendBinary(channel byte, data []byte) error {
	frame := make([]byte, 1+len(data))
	frame[0] = channel
	copy(frame[1:], data)
	return s.send(websocket.BinaryMessage, frame)
}

func resizePty(f *os.File, cols, rows uint16) {
	if f == nil || cols == 0 || rows == 0 {
		return
	}
	ws := struct{ rows, cols, xpixel, ypixel uint16 }{rows, cols, 0, 0}
	syscall.Syscall(syscall.SYS_IOCTL, f.Fd(),
		uintptr(syscall.TIOCSWINSZ), uintptr(unsafe.Pointer(&ws)))
}

func (s *Session) startTerminal() error {
	cmd := exec.Command("/bin/bash", "--login")
	cmd.Env = append(os.Environ(),
		"TERM=xterm-256color",
		"COLORTERM=truecolor",
		"HOME=/home/bashuser",
		"USER=bashuser",
		"SHELL=/bin/bash",
	)
	cmd.Dir = workspace

	ptmx, err := pty.Start(cmd)
	if err != nil {
		return fmt.Errorf("pty.Start terminal: %w", err)
	}
	s.termPty = ptmx
	s.termCmd = cmd

	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := ptmx.Read(buf)
			if n > 0 {
				s.sendBinary(ChTerminal, buf[:n])
			}
			if err != nil {
				break
			}
		}
	}()
	return nil
}

func (s *Session) runScript(path, content string, args []string) {
	s.scriptMu.Lock()
	if s.scriptCmd != nil && s.scriptCmd.Process != nil {
		s.scriptCmd.Process.Signal(syscall.SIGTERM)
		time.Sleep(100 * time.Millisecond)
		s.scriptCmd.Process.Kill()
		if s.scriptPty != nil {
			s.scriptPty.Close()
		}
		s.scriptPty = nil
		s.scriptCmd = nil
	}
	s.scriptMu.Unlock()

	// Write script to workspace with Unix line endings
	fullPath := filepath.Join(workspace, filepath.Base(path))
	// Normalize line endings: replace \r\n and lone \r with \n
	normalized := strings.ReplaceAll(content, "\r\n", "\n")
	normalized = strings.ReplaceAll(normalized, "\r", "\n")
	if err := os.WriteFile(fullPath, []byte(normalized), 0755); err != nil {
		s.sendJSON(map[string]any{"type": "error", "message": "Cannot write script: " + err.Error()})
		return
	}

	s.sendJSON(map[string]any{"type": "script_started"})

	cmdArgs := append([]string{fullPath}, args...)
	cmd := exec.Command("/bin/bash", cmdArgs...)
	cmd.Env = append(os.Environ(),
		"TERM=xterm-256color",
		"HOME=/home/bashuser",
		"USER=bashuser",
	)
	cmd.Dir = workspace
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}

	ptmx, err := pty.Start(cmd)
	if err != nil {
		s.sendJSON(map[string]any{"type": "error", "message": "Cannot start script: " + err.Error()})
		return
	}

	s.scriptMu.Lock()
	s.scriptPty = ptmx
	s.scriptCmd = cmd
	s.scriptMu.Unlock()

	start := time.Now()

	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := ptmx.Read(buf)
			if n > 0 {
				s.sendBinary(ChScript, buf[:n])
			}
			if err != nil {
				break
			}
		}
		cmd.Wait()
		rc := 0
		if cmd.ProcessState != nil {
			rc = cmd.ProcessState.ExitCode()
		}
		elapsed := time.Since(start).Seconds()

		s.scriptMu.Lock()
		s.scriptPty = nil
		s.scriptCmd = nil
		s.scriptMu.Unlock()

		s.sendJSON(map[string]any{
			"type":      "script_done",
			"exit_code": rc,
			"elapsed":   elapsed,
		})
	}()
}

// safeInHome checks path is inside homeDir (allows workspace + home)
func safeInHome(path string) bool {
	abs, err := filepath.Abs(path)
	if err != nil {
		return false
	}
	return strings.HasPrefix(abs, homeDir+"/") || abs == homeDir
}

func (s *Session) handleFileList(dir string) {
	if dir == "" {
		dir = workspace
	}
	// Resolve relative paths from workspace
	if !filepath.IsAbs(dir) {
		dir = filepath.Join(workspace, dir)
	}
	dir = filepath.Clean(dir)
	if !safeInHome(dir) {
		s.sendJSON(map[string]any{"type": "error", "message": "Access denied"})
		return
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		s.sendJSON(map[string]any{"type": "error", "message": err.Error()})
		return
	}
	files := make([]FileInfo, 0, len(entries))
	for _, e := range entries {
		// Skip hidden files (except .bashrc)
		if strings.HasPrefix(e.Name(), ".") && e.Name() != ".bashrc" {
			continue
		}
		info, _ := e.Info()
		if info == nil {
			continue
		}
		relPath, _ := filepath.Rel(homeDir, filepath.Join(dir, e.Name()))
		files = append(files, FileInfo{
			Name:     e.Name(),
			Path:     relPath,
			Size:     info.Size(),
			Modified: info.ModTime().Unix(),
			IsDir:    e.IsDir(),
		})
	}
	s.sendJSON(map[string]any{"type": "file_list_result", "files": files, "dir": dir})
}

func (s *Session) handleFileRead(path string) {
	var fullPath string
	if filepath.IsAbs(path) {
		fullPath = filepath.Clean(path)
	} else {
		// Try workspace first, then home
		candidate := filepath.Join(workspace, filepath.Clean("/"+path))
		if _, err := os.Stat(candidate); err == nil {
			fullPath = candidate
		} else {
			fullPath = filepath.Join(homeDir, filepath.Clean("/"+path))
		}
	}
	if !safeInHome(fullPath) {
		s.sendJSON(map[string]any{"type": "error", "message": "Access denied"})
		return
	}
	data, err := os.ReadFile(fullPath)
	if err != nil {
		s.sendJSON(map[string]any{"type": "error", "message": err.Error()})
		return
	}
	relPath, _ := filepath.Rel(homeDir, fullPath)
	s.sendJSON(map[string]any{
		"type":    "file_content",
		"path":    relPath,
		"content": string(data),
	})
}

func (s *Session) handleFileWrite(path, content string) {
	var fullPath string
	if filepath.IsAbs(path) {
		fullPath = filepath.Clean(path)
	} else {
		fullPath = filepath.Join(workspace, filepath.Base(path))
	}
	if !safeInHome(fullPath) {
		s.sendJSON(map[string]any{"type": "error", "message": "Access denied"})
		return
	}
	// Normalize line endings
	normalized := strings.ReplaceAll(content, "\r\n", "\n")
	normalized = strings.ReplaceAll(normalized, "\r", "\n")
	if err := os.WriteFile(fullPath, []byte(normalized), 0644); err != nil {
		s.sendJSON(map[string]any{"type": "error", "message": err.Error()})
		return
	}
	relPath, _ := filepath.Rel(homeDir, fullPath)
	s.sendJSON(map[string]any{"type": "file_written", "path": relPath})
}

func (s *Session) handleFileNew(name string) {
	safe := filepath.Join(workspace, filepath.Base(name))
	if _, err := os.Stat(safe); os.IsNotExist(err) {
		os.WriteFile(safe, []byte("#!/bin/bash\n\nset -euo pipefail\n\n"), 0644)
	}
	relPath, _ := filepath.Rel(homeDir, safe)
	s.sendJSON(map[string]any{"type": "file_created", "name": filepath.Base(name), "path": relPath})
}

func handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("WS upgrade error: %v", err)
		return
	}
	defer conn.Close()

	sess := &Session{conn: conn}

	conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	_, raw, err := conn.ReadMessage()
	if err != nil {
		log.Printf("Auth read error: %v", err)
		return
	}
	conn.SetReadDeadline(time.Time{})

	var authMsg CtrlMsg
	if json.Unmarshal(raw, &authMsg) != nil || authMsg.Type != "auth" || authMsg.Token != wsToken {
		log.Printf("Auth failed")
		conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"error","message":"Authentication failed"}`))
		return
	}

	if err := sess.startTerminal(); err != nil {
		log.Printf("Terminal start error: %v", err)
		return
	}
	defer func() {
		if sess.termCmd != nil && sess.termCmd.Process != nil {
			sess.termCmd.Process.Kill()
		}
		if sess.termPty != nil {
			sess.termPty.Close()
		}
	}()

	resizePty(sess.termPty, 220, 50)

	for {
		msgType, data, err := conn.ReadMessage()
		if err != nil {
			break
		}

		if msgType == websocket.BinaryMessage {
			if len(data) < 2 {
				continue
			}
			ch := data[0]
			payload := data[1:]
			if ch == ChTerminal && sess.termPty != nil {
				sess.termPty.Write(payload)
			} else if ch == ChScript {
				sess.scriptMu.Lock()
				sp := sess.scriptPty
				sess.scriptMu.Unlock()
				if sp != nil {
					sp.Write(payload)
				}
			}
			continue
		}

		var msg CtrlMsg
		if json.Unmarshal(data, &msg) != nil {
			continue
		}

		switch msg.Type {
		case "run_script":
			go sess.runScript(msg.Path, msg.Content, msg.Args)
		case "stop_script":
			sess.scriptMu.Lock()
			if sess.scriptCmd != nil && sess.scriptCmd.Process != nil {
				sess.scriptCmd.Process.Signal(syscall.SIGTERM)
			}
			sess.scriptMu.Unlock()
		case "resize_terminal":
			resizePty(sess.termPty, msg.Cols, msg.Rows)
		case "file_list":
			sess.handleFileList(msg.Dir)
		case "file_read":
			sess.handleFileRead(msg.Path)
		case "file_write":
			sess.handleFileWrite(msg.Path, msg.Content)
		case "file_new":
			sess.handleFileNew(msg.Name)
		}
	}
}

func main() {
	if wsToken == "" {
		log.Fatal("WS_TOKEN env variable is required")
	}
	if err := os.MkdirAll(workspace, 0755); err != nil {
		log.Fatal("Cannot create workspace:", err)
	}

	http.HandleFunc("/ws", handleWS)
	http.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(200)
		w.Write([]byte("ok"))
	})

	addr := ":8765"
	log.Printf("bash-ws-server listening on %s", addr)
	if err := http.ListenAndServe(addr, nil); err != nil {
		log.Fatal(err)
	}
}
