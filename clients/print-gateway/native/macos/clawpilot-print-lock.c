#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

enum {
  EXIT_USAGE_ERROR = 64,
  EXIT_EXEC_ERROR = 71,
  EXIT_LOCK_TIMEOUT = 75,
};

static uint64_t monotonic_milliseconds(void) {
  struct timespec value;
  if (clock_gettime(CLOCK_MONOTONIC, &value) != 0) return 0;
  return (uint64_t)value.tv_sec * 1000u + (uint64_t)value.tv_nsec / 1000000u;
}

static int parse_timeout(const char *value, uint64_t *output) {
  char *end = NULL;
  errno = 0;
  unsigned long long parsed = strtoull(value, &end, 10);
  if (errno != 0 || end == value || *end != '\0' || parsed < 1 || parsed > 60000) {
    return 0;
  }
  *output = (uint64_t)parsed;
  return 1;
}

int main(int argc, char **argv) {
  const char *lock_path = NULL;
  const char *command = NULL;
  uint64_t timeout_ms = 0;
  int command_index = -1;

  for (int index = 1; index < argc; index += 1) {
    if (strcmp(argv[index], "--lock-path") == 0 && index + 1 < argc) {
      lock_path = argv[++index];
    } else if (strcmp(argv[index], "--timeout-ms") == 0 && index + 1 < argc) {
      if (!parse_timeout(argv[++index], &timeout_ms)) return EXIT_USAGE_ERROR;
    } else if (strcmp(argv[index], "--command") == 0 && index + 1 < argc) {
      command_index = index + 1;
      command = argv[command_index];
      break;
    } else {
      return EXIT_USAGE_ERROR;
    }
  }

  if (lock_path == NULL || command == NULL || timeout_ms == 0) return EXIT_USAGE_ERROR;

  int descriptor = open(lock_path, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR);
  if (descriptor < 0) return EXIT_EXEC_ERROR;

  const uint64_t started_at = monotonic_milliseconds();
  for (;;) {
    if (flock(descriptor, LOCK_EX | LOCK_NB) == 0) break;
    if (errno != EWOULDBLOCK && errno != EAGAIN) return EXIT_EXEC_ERROR;
    const uint64_t now = monotonic_milliseconds();
    if (now < started_at || now - started_at >= timeout_ms) return EXIT_LOCK_TIMEOUT;
    struct timespec delay = { .tv_sec = 0, .tv_nsec = 25 * 1000 * 1000 };
    nanosleep(&delay, NULL);
  }

  // The descriptor deliberately remains open across exec so the advisory
  // kernel lock is held for the exact lifetime of the raw-delivery helper.
  execv(command, &argv[command_index]);
  return EXIT_EXEC_ERROR;
}
