#ifndef BREEZER_STORAGE_CLONE_SESSION_H_
#define BREEZER_STORAGE_CLONE_SESSION_H_

#include <dirent.h>
#include <fcntl.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>

#include <cerrno>
#include <chrono>
#include <cstdlib>
#include <cstring>
#include <string>
#include <utility>

namespace breezer::clone_sessions {

inline constexpr char kLeaseName[] = ".breezer-session-v1";
inline constexpr char kLeaseContents[] = "Breezer signature clone session v1\n";
inline constexpr char kPrefix[] = "code_sign_clone.";

class Fd {
 public:
  Fd() = default;
  explicit Fd(int value) : value_(value) {}
  ~Fd() { if (value_ >= 0) close(value_); }
  Fd(const Fd&) = delete;
  Fd& operator=(const Fd&) = delete;
  Fd(Fd&& other) noexcept : value_(other.release()) {}
  Fd& operator=(Fd&& other) noexcept {
    if (this != &other) {
      if (value_ >= 0) close(value_);
      value_ = other.release();
    }
    return *this;
  }
  int get() const { return value_; }
  bool valid() const { return value_ >= 0; }
  int release() { return std::exchange(value_, -1); }
 private:
  int value_ = -1;
};

inline bool ValidSuffix(const std::string& suffix) {
  if (suffix.size() != 6) return false;
  for (unsigned char c : suffix) {
    if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
          (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-'))
      return false;
  }
  return true;
}

inline bool PrivateFile(int fd, bool directory) {
  struct stat s;
  return fd >= 0 && fstat(fd, &s) == 0 && s.st_uid == geteuid() &&
         (s.st_mode & 07777) == (directory ? 0700 : 0600) &&
         (directory ? S_ISDIR(s.st_mode) : S_ISREG(s.st_mode) && s.st_nlink == 1);
}

// Walk from / using directory descriptors; never follow a symlink component.
inline Fd OpenRoot(const std::string& path, bool create) {
  if (path.empty() || path[0] != '/' || path.back() == '/') return Fd();
  Fd current(open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC));
  size_t start = 1;
  while (current.valid() && start < path.size()) {
    size_t end = path.find('/', start);
    bool last = end == std::string::npos;
    std::string name = path.substr(start, last ? end : end - start);
    if (name.empty() || name == "." || name == ".." || name.find('\0') != std::string::npos) return Fd();
    if (last && create && mkdirat(current.get(), name.c_str(), 0700) != 0 && errno != EEXIST)
      return Fd();
    current = Fd(openat(current.get(), name.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC));
    if (last) return PrivateFile(current.get(), true) ? std::move(current) : Fd();
    start = end + 1;
  }
  return Fd();
}

inline Fd LockRoot(int root, bool wait) {
  Fd gate(openat(root, ".cleanup-lock", O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0600));
  if (!PrivateFile(gate.get(), false)) return Fd();
  int result;
  do { result = flock(gate.get(), LOCK_EX | (wait ? 0 : LOCK_NB)); }
  while (result != 0 && errno == EINTR);
  return result == 0 ? std::move(gate) : Fd();
}

struct Session {
  std::string path;
  Fd lease;
};

inline Session CreateSession(const std::string& root_path) {
  Fd root = OpenRoot(root_path, true);
  if (!root.valid()) return {};
  Fd gate = LockRoot(root.get(), true);
  if (!gate.valid()) return {};
  constexpr char alphabet[] = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  for (size_t attempt = 0; attempt < 16; ++attempt) {
    std::string name = kPrefix;
    for (size_t i = 0; i < 6; ++i) name += alphabet[arc4random_uniform(sizeof(alphabet) - 1)];
    if (mkdirat(root.get(), name.c_str(), 0700) != 0) {
      if (errno == EEXIST) continue;
      return {};
    }
    Fd dir(openat(root.get(), name.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC));
    Fd lease(dir.valid() ? openat(dir.get(), kLeaseName, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600) : -1);
    if (!PrivateFile(dir.get(), true) || !PrivateFile(lease.get(), false) ||
        flock(lease.get(), LOCK_EX | LOCK_NB) != 0 ||
        write(lease.get(), kLeaseContents, sizeof(kLeaseContents) - 1) != sizeof(kLeaseContents) - 1) {
      if (dir.valid()) unlinkat(dir.get(), kLeaseName, 0);
      unlinkat(root.get(), name.c_str(), AT_REMOVEDIR);
      return {};
    }
    return {root_path + "/" + name, std::move(lease)};
  }
  return {};
}

struct Limits {
  size_t entries = 256;
  size_t sessions = 8;
  size_t nodes = 8192;
  std::chrono::milliseconds duration{100};
};

inline bool SameEntry(int parent, const char* name, int fd) {
  struct stat entry, opened;
  return fstatat(parent, name, &entry, AT_SYMLINK_NOFOLLOW) == 0 &&
         fstat(fd, &opened) == 0 && entry.st_dev == opened.st_dev &&
         entry.st_ino == opened.st_ino && !S_ISLNK(entry.st_mode);
}

inline bool ValidLease(int fd) {
  struct stat s;
  char contents[sizeof(kLeaseContents)];
  return PrivateFile(fd, false) && fstat(fd, &s) == 0 &&
         s.st_size == sizeof(kLeaseContents) - 1 &&
         pread(fd, contents, sizeof(contents), 0) == sizeof(kLeaseContents) - 1 &&
         memcmp(contents, kLeaseContents, sizeof(kLeaseContents) - 1) == 0;
}

using Deadline = std::chrono::steady_clock::time_point;

inline bool RemoveContents(int directory, size_t& nodes, Deadline deadline,
                           size_t depth, bool preserve_lease) {
  if (depth > 64 || nodes == 0 || std::chrono::steady_clock::now() >= deadline)
    return false;
  int duplicate = fcntl(directory, F_DUPFD_CLOEXEC, 0);
  if (duplicate < 0) return false;
  DIR* entries = fdopendir(duplicate);
  if (!entries) { close(duplicate); return false; }
  bool success = true;
  while (true) {
    errno = 0;
    dirent* entry = readdir(entries);
    if (!entry) { success = errno == 0; break; }
    const char* name = entry->d_name;
    if (!strcmp(name, ".") || !strcmp(name, "..") ||
        (preserve_lease && !strcmp(name, kLeaseName))) continue;
    if (nodes == 0 || std::chrono::steady_clock::now() >= deadline) {
      success = false;
      break;
    }
    --nodes;
    struct stat info;
    if (fstatat(directory, name, &info, AT_SYMLINK_NOFOLLOW) != 0) {
      success = false;
      break;
    }
    if (S_ISDIR(info.st_mode)) {
      struct stat parent;
      if (fstat(directory, &parent) != 0 || info.st_dev != parent.st_dev) {
        success = false;
        break;
      }
      Fd child(openat(directory, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC));
      if (!child.valid() || !SameEntry(directory, name, child.get()) ||
          !RemoveContents(child.get(), nodes, deadline, depth + 1, false) ||
          !SameEntry(directory, name, child.get()) ||
          unlinkat(directory, name, AT_REMOVEDIR) != 0) {
        success = false;
        break;
      }
    } else if (unlinkat(directory, name, 0) != 0) {
      success = false;
      break;
    }
  }
  closedir(entries);
  return success;
}

inline bool PayloadEmpty(int directory) {
  int fresh = openat(directory, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fresh < 0) return false;
  DIR* entries = fdopendir(fresh);
  if (!entries) { close(fresh); return false; }
  bool empty = true;
  while (true) {
    errno = 0;
    dirent* entry = readdir(entries);
    if (!entry) { empty = errno == 0; break; }
    if (strcmp(entry->d_name, ".") && strcmp(entry->d_name, "..") &&
        strcmp(entry->d_name, kLeaseName)) {
      empty = false;
      break;
    }
  }
  closedir(entries);
  return empty;
}

inline bool CleanupSession(int root, const std::string& name, size_t& nodes,
                           Deadline deadline) {
  if (!name.starts_with(kPrefix) || !ValidSuffix(name.substr(sizeof(kPrefix) - 1)))
    return false;
  Fd dir(openat(root, name.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC));
  if (!PrivateFile(dir.get(), true) || !SameEntry(root, name.c_str(), dir.get()))
    return false;
  Fd lease(openat(dir.get(), kLeaseName, O_RDWR | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK));
  if (!ValidLease(lease.get()) || flock(lease.get(), LOCK_EX | LOCK_NB) != 0 ||
      !SameEntry(dir.get(), kLeaseName, lease.get())) return false;
  // The marker stays locked and present during partial, budget-limited deletion.
  if (!RemoveContents(dir.get(), nodes, deadline, 0, true) || nodes == 0 ||
      !PayloadEmpty(dir.get()) ||
      std::chrono::steady_clock::now() >= deadline ||
      !SameEntry(root, name.c_str(), dir.get()) ||
      !SameEntry(dir.get(), kLeaseName, lease.get())) return false;
  --nodes;
  if (unlinkat(dir.get(), kLeaseName, 0) != 0) return false;
  return unlinkat(root, name.c_str(), AT_REMOVEDIR) == 0;
}

inline size_t Cleanup(const std::string& root_path,
                      const std::string& only_suffix = {},
                      Limits limits = {}) {
  if (!only_suffix.empty() && !ValidSuffix(only_suffix)) return 0;
  Fd root = OpenRoot(root_path, false);
  if (!root.valid()) return 0;
  Fd gate = LockRoot(root.get(), false);
  if (!gate.valid()) return 0;
  Deadline deadline = std::chrono::steady_clock::now() + limits.duration;
  if (!only_suffix.empty())
    return limits.sessions && CleanupSession(root.get(), std::string(kPrefix) + only_suffix, limits.nodes, deadline);
  int duplicate = fcntl(root.get(), F_DUPFD_CLOEXEC, 0);
  if (duplicate < 0) return 0;
  DIR* entries = fdopendir(duplicate);
  if (!entries) { close(duplicate); return 0; }
  size_t scanned = 0, removed = 0;
  while (scanned < limits.entries && removed < limits.sessions && limits.nodes &&
         std::chrono::steady_clock::now() < deadline) {
    dirent* entry = readdir(entries);
    if (!entry) break;
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
    ++scanned;
    removed += CleanupSession(root.get(), entry->d_name, limits.nodes, deadline);
  }
  closedir(entries);
  return removed;
}

}  // namespace breezer::clone_sessions

#endif
