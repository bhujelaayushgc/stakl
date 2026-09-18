//go:build darwin || linux

package supervisor

import (
	"fmt"
	"os"
	"os/exec"
	"syscall"
)

func Detach(cmd *exec.Cmd) { cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true} }
func Group(cmd *exec.Cmd)  { cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true} }
func SignalGroup(pid int, signal string) error {
	if pid <= 1 {
		return fmt.Errorf("refusing invalid process group")
	}
	s := map[string]syscall.Signal{"TERM": syscall.SIGTERM, "INT": syscall.SIGINT, "QUIT": syscall.SIGQUIT, "HUP": syscall.SIGHUP, "KILL": syscall.SIGKILL}[signal]
	if s == 0 {
		return fmt.Errorf("unsupported signal %q", signal)
	}
	return syscall.Kill(-pid, s)
}
func GroupAlive(pid int) bool { return pid > 1 && syscall.Kill(-pid, 0) == nil }
func PIDAlive(pid int) bool   { return pid > 1 && syscall.Kill(pid, 0) == nil }
func Lock(path string) (*os.File, error) {
	f, e := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if e != nil {
		return nil, e
	}
	if e = syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); e != nil {
		f.Close()
		return nil, fmt.Errorf("LocalDesk is already running for this state directory")
	}
	return f, nil
}
