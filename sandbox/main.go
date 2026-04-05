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
	Name    string   `json:"name,omitempty"`
	Content string   `json:"content,omitempty"`
	Args    []string `json:"args,omitempty"`
	Cols    uint16   `json:"cols,omitempty"`
	Rows    uint16   `json:"rows,omitempty"`
}

type FileInfo struct {
	Name     string `json:"name"`
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
	if f == nil {
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
		"PS1=\\[\\033[32m\\]\\u@bashforge\\[\\033[0m\\]:\\[\\033[34m\\]\\w\\[\\033[0m\\]$ ",
		"HOME=/home/bashuser",
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
				if sendErr := s.sendBinary(ChTerminal, buf[:n]); sendErr != nil {
					break
				}
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

	fullPath := filepath.Join(workspace, filepath.Base(path))
	if err := os.WriteFile(fullPath, []byte(content), 0755); err != nil {
		s.sendJSON(map[string]any{"type": "error", "message": "Cannot write script: " + err.Error()})
		return
	}

	s.sendJSON(map[string]any{"type": "script_started"})

	cmdArgs := append([]string{fullPath}, args...)
	cmd := exec.Command("/bin/bash", cmdArgs...)
	cmd.Env = append(os.Environ(), "TERM=xterm-256color")
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
		s.sendJSON(map[string]any{"type": "script_done", "exit_code": rc, "elapsed": elapsed})
	}()
}

func (s *Session) handleFileList() {
	entries, err := os.ReadDir(workspace)
	if err != nil {
		s.sendJSON(map[string]any{"type": "error", "message": err.Error()})
		return
	}
	files := make([]FileInfo, 0, len(entries))
	for _, e := range entries {
		info, _ := e.Info()
		if info == nil {
			continue
		}
		files = append(files, FileInfo{
			Name: e.Name(), Size: info.Size(),
			Modified: info.ModTime().Unix(), IsDir: e.IsDir(),
		})
	}
	s.sendJSON(map[string]any{"type": "file_list_result", "files": files})
}

func (s *Session) handleFileRead(path string) {
	safe := filepath.Join(workspace, filepath.Clean("/"+path))
	if !strings.HasPrefix(safe, workspace) {
		s.sendJSON(map[string]any{"type": "error", "message": "Access denied"})
		return
	}
	data, err := os.ReadFile(safe)
	if err != nil {
		s.sendJSON(map[string]any{"type": "error", "message": err.Error()})
		return
	}
	s.sendJSON(map[string]any{"type": "file_content", "path": filepath.Base(path), "content": string(data)})
}

func (s *Session) handleFileWrite(path, content string) {
	safe := filepath.Join(workspace, filepath.Clean("/"+filepath.Base(path)))
	if !strings.HasPrefix(safe, workspace) {
		s.sendJSON(map[string]any{"type": "error", "message": "Access denied"})
		return
	}
	if err := os.WriteFile(safe, []byte(content), 0644); err != nil {
		s.sendJSON(map[string]any{"type": "error", "message": err.Error()})
		return
	}
	s.sendJSON(map[string]any{"type": "file_written", "path": filepath.Base(path)})
}

func (s *Session) handleFileNew(name string) {
	safe := filepath.Join(workspace, filepath.Base(name))
	if _, err := os.Stat(safe); os.IsNotExist(err) {
		os.WriteFile(safe, []byte("#!/bin/bash\n\nset -euo pipefail\n\n"), 0644)
	}
	s.sendJSON(map[string]any{"type": "file_created", "name": filepath.Base(name)})
}

func handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("WS upgrade error: %v", err)
		return
	}
	defer conn.Close()

	// Set up ping/pong handlers so Python's websockets library stays happy
	// gorilla/websocket does NOT auto-respond to pings — must set handler explicitly
	conn.SetPongHandler(func(data string) error {
		return nil
	})
	conn.SetPingHandler(func(data string) error {
		return conn.WriteControl(
			websocket.PongMessage,
			[]byte(data),
			time.Now().Add(5*time.Second),
		)
	})

	sess := &Session{conn: conn}

	// Authenticate
	conn.SetReadDeadline(time.Now().Add(15 * time.Second))
	_, raw, err := conn.ReadMessage()
	conn.SetReadDeadline(time.Time{}) // clear deadline
	if err != nil {
		log.Printf("Auth read error: %v", err)
		return
	}

	var authMsg CtrlMsg
	if json.Unmarshal(raw, &authMsg) != nil || authMsg.Type != "auth" || authMsg.Token != wsToken {
		log.Printf("Auth failed — got type=%q token_len=%d", authMsg.Type, len(authMsg.Token))
		conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"error","message":"Authentication failed"}`))
		return
	}
	log.Printf("Auth OK for new session")

	// Start terminal shell
	if err := sess.startTerminal(); err != nil {
		log.Printf("Terminal start error: %v", err)
		conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"error","message":"Failed to start shell"}`))
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
	log.Printf("Session ready, entering message loop")

	// Message loop
	for {
		msgType, data, err := conn.ReadMessage()
		if err != nil {
			log.Printf("Read error (session ending): %v", err)
			break
		}

		if msgType == websocket.BinaryMessage {
			if len(data) < 2 {
				continue
			}
			ch      := data[0]
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
		log.Printf("Control msg: %s", msg.Type)

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
			if msg.Cols > 0 && msg.Rows > 0 {
				resizePty(sess.termPty, msg.Cols, msg.Rows)
			}
		case "file_list":
			sess.handleFileList()
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
	log.Printf("bash-ws-server listening on :8765")
	if err := http.ListenAndServe(":8765", nil); err != nil {
		log.Fatal(err)
	}
}