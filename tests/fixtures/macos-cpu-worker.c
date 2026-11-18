// Test fixture from the retained native CPU accounting review, 2026-11-08.
// The worker compares its own getrusage CPU with the helper counter window.
#include <sys/resource.h>
#include <sys/wait.h>
#include <time.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
static uint64_t ns(struct timespec t) { return (uint64_t)t.tv_sec * 1000000000 + t.tv_nsec; }
static uint64_t ru(struct rusage r) { return ((uint64_t)r.ru_utime.tv_sec + r.ru_stime.tv_sec) * 1000000 + r.ru_utime.tv_usec + r.ru_stime.tv_usec; }
static void capture(const char *helper) {
  char pid[32]; snprintf(pid, sizeof(pid), "%d", getpid());
  pid_t child = fork(); if (child < 0) exit(1);
  if (!child) { execl(helper, helper, pid, (char *)NULL); _exit(127); }
  int status; if (waitpid(child, &status, 0) != child || !WIFEXITED(status) || WEXITSTATUS(status)) exit(1);
}
int main(int argc, char **argv) {
  if (argc != 2) return 1;
  struct rusage before, after; struct timespec start, now;
  capture(argv[1]); capture(argv[1]);
  if (getrusage(RUSAGE_SELF, &before) || clock_gettime(CLOCK_PROCESS_CPUTIME_ID, &start)) return 1;
  volatile uint64_t n = 0;
  do { for (int i = 0; i < 10000; i++) n++; if (clock_gettime(CLOCK_PROCESS_CPUTIME_ID, &now)) return 1; } while (ns(now) - ns(start) < 80000000);
  if (getrusage(RUSAGE_SELF, &after)) return 1;
  capture(argv[1]); capture(argv[1]);
  fprintf(stderr, "%llu\n", (unsigned long long)(ru(after) - ru(before)) * 1000);
  return n == 0;
}
