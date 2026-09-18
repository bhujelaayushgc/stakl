//go:build linux

package supervisor

import (
	"golang.org/x/sys/unix"
	"os"
	"strings"
)

// WaitExited observes exit without reaping, reserving the PID until group cleanup.
func WaitExited(pid int) error {
	var info unix.Siginfo
	for {
		err := unix.Waitid(unix.P_PID, pid, &info, unix.WEXITED|unix.WNOWAIT, nil)
		if err == unix.EINTR {
			continue
		}
		return err
	}
}

func BootID() (string, error) {
	b, e := os.ReadFile("/proc/sys/kernel/random/boot_id")
	return strings.TrimSpace(string(b)), e
}
