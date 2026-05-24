//go:build !linux

package main

// The agent targets Linux VPSs; on other platforms memory/disk collection is
// a no-op so `go build ./...` stays portable (CI + dev builds). hostname / os
// / arch / cpu / docker still work everywhere.

func memTotalMb() int64          { return 0 }
func diskTotalGb(_ string) int64 { return 0 }
