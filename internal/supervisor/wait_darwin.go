//go:build darwin

package supervisor

import (
	"golang.org/x/sys/unix"
	"syscall"
	"unsafe"
)

// Darwin waitid with WNOWAIT keeps the group leader unreaped during cleanup.
func WaitExited(pid int) error {
	var info [128]byte
	for {
		_, _, e := syscall.Syscall6(syscall.SYS_WAITID, 1, uintptr(pid), uintptr(unsafe.Pointer(&info[0])), syscall.WEXITED|syscall.WNOWAIT, 0, 0)
		if e == syscall.EINTR {
			continue
		}
		if e != 0 {
			return e
		}
		return nil
	}
}

func BootID() (string, error) { return unix.Sysctl("kern.bootsessionuuid") }
