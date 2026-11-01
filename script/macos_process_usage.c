// Read-only diagnostic. Build with: xcrun clang -O2 -Wall -Wextra -Werror
// script/macos_process_usage.c -o build/macos-process-usage
#include <errno.h>
#include <inttypes.h>
#include <limits.h>
#include <libproc.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/resource.h>
#include <time.h>

static uint64_t monotonic_ns(void) {
  struct timespec now;
  if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) {
    perror("clock_gettime");
    exit(1);
  }
  return (uint64_t)now.tv_sec * 1000000000 + (uint64_t)now.tv_nsec;
}

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "Usage: macos-process-usage PID [PID ...]\n");
    return 2;
  }
  for (int i = 1; i < argc; ++i) {
    char *end;
    errno = 0;
    long pid = strtol(argv[i], &end, 10);
    if (errno || *end || end == argv[i] || pid < 1 || pid > INT_MAX) {
      fprintf(stderr, "Invalid PID\n");
      return 2;
    }
  }
  printf("{\"schema\":1,\"captureStartedNs\":\"%" PRIu64
         "\",\"processes\":[", monotonic_ns());
  for (int i = 1; i < argc; ++i) {
    pid_t pid = (pid_t)strtol(argv[i], NULL, 10);
    struct rusage_info_v4 info = {0};
    if (i > 1) putchar(',');
    printf("{\"pid\":%d", pid);
    if (proc_pid_rusage(pid, RUSAGE_INFO_V4, (rusage_info_t *)&info) != 0) {
      printf(",\"status\":\"unavailable\",\"errno\":%d}", errno);
      continue;
    }
    if (info.ri_proc_exit_abstime != 0) {
      printf(",\"status\":\"exited\"}");
      continue;
    }
    printf(",\"status\":\"ok\",\"startAbstime\":\"%" PRIu64
           "\",\"executableUuid\":\"", info.ri_proc_start_abstime);
    for (size_t j = 0; j < sizeof(info.ri_uuid); ++j) {
      printf("%02x", info.ri_uuid[j]);
    }
    printf("\",\"physicalFootprintBytes\":%" PRIu64
           ",\"residentBytes\":%" PRIu64
           ",\"lifetimeMaxPhysicalFootprintBytes\":%" PRIu64 "}",
           info.ri_phys_footprint, info.ri_resident_size,
           info.ri_lifetime_max_phys_footprint);
  }
  printf("],\"captureEndedNs\":\"%" PRIu64 "\"}\n", monotonic_ns());
  return ferror(stdout) ? 1 : 0;
}
