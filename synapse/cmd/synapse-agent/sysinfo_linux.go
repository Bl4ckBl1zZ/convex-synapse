//go:build linux

package main

import (
	"bufio"
	"os"
	"strconv"
	"strings"
	"syscall"
)

// memTotalMb reads MemTotal from /proc/meminfo (kB) and returns it in MB.
// Returns 0 on any read/parse failure.
func memTotalMb() int64 {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		if !strings.HasPrefix(line, "MemTotal:") {
			continue
		}
		fields := strings.Fields(line) // e.g. ["MemTotal:", "16384000", "kB"]
		if len(fields) >= 2 {
			if kb, err := strconv.ParseInt(fields[1], 10, 64); err == nil {
				return kb / 1024
			}
		}
		return 0
	}
	return 0
}

// diskTotalGb returns the total size of the filesystem backing `path`, in GB
// (decimal, matching how VPS plans advertise disk). Returns 0 on failure.
func diskTotalGb(path string) int64 {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0
	}
	total := int64(st.Blocks) * int64(st.Bsize)
	return total / (1000 * 1000 * 1000)
}
