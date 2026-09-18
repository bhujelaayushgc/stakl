//go:build windows

package supervisor

import (
	"fmt"
	"os"
	"os/exec"
)

func Detach(cmd *exec.Cmd) {}
func Group(cmd *exec.Cmd)  {}
func SignalGroup(pid int, signal string) error {
	return fmt.Errorf("Windows job-object supervision is not implemented")
}
func GroupAlive(pid int) bool            { return false }
func PIDAlive(pid int) bool              { return false }
func Lock(path string) (*os.File, error) { return nil, fmt.Errorf("Windows is not supported yet") }
func WaitExited(pid int) error           { return fmt.Errorf("Windows is not supported") }

func BootID() (string, error) { return "", fmt.Errorf("Windows is not supported yet") }
