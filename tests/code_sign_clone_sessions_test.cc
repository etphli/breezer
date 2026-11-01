#include "features/storage/code-sign-clones/clone_session.h"

#include <sys/clonefile.h>
#include <sys/wait.h>
#include <signal.h>

#include <filesystem>
#include <iostream>
#include <stdexcept>
#include <vector>

namespace fs = std::filesystem;
namespace clones = breezer::clone_sessions;

void Require(bool value, const char* message) {
  if (!value) throw std::runtime_error(message);
}

void Write(const fs::path& path, const std::string& text) {
  clones::Fd fd(open(path.c_str(), O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600));
  Require(fd.valid() && write(fd.get(), text.data(), text.size()) == static_cast<ssize_t>(text.size()), "fixture write");
}

int main() {
  alarm(30);
  char pattern[] = "/private/tmp/breezer-clone-lifecycle.XXXXXX";
  char* temp = mkdtemp(pattern);
  Require(temp != nullptr, "fixture root");
  fs::path fixture(temp), root = fixture / "sessions-v1";
  std::vector<pid_t> children;
  try {
    auto active = clones::CreateSession(root.string());
    Require(active.lease.valid(), "create active session");
    Write(fs::path(active.path) / "payload", "keep");
    Require(clones::Cleanup(root.string()) == 0 && fs::exists(active.path), "active lease removed");
    auto dead = clones::CreateSession(root.string());
    std::string abandoned = dead.path;
    Write(fs::path(abandoned) / "payload", "abandoned");
    dead.lease = clones::Fd();
    Require(clones::Cleanup(root.string()) == 1 && !fs::exists(abandoned), "abandoned clone was retained");
    Require(fs::exists(active.path), "active session lost during sweep");
    Require(clones::Cleanup(root.string()) == 0, "repeat cleanup not idempotent");
    std::cout << "PASS active, abandoned and repeated cleanup\n";

    fs::path unknown = root / "code_sign_clone.Legacy";
    fs::create_directory(unknown);
    chmod(unknown.c_str(), 0700);
    Write(unknown / "keep", "legacy or incomplete ownership");
    auto invalid = clones::CreateSession(root.string());
    std::string invalid_path = invalid.path;
    invalid.lease = clones::Fd();
    Write(fs::path(invalid_path) / clones::kLeaseName, "invalid");
    Require(clones::Cleanup(root.string()) == 0 && fs::exists(unknown / "keep") && fs::exists(invalid_path), "ambiguous ownership removed");

    fs::path outside = fixture / "outside";
    fs::create_directory(outside);
    Write(outside / "sentinel", "preserve");
    Write(outside / "lease", clones::kLeaseContents);
    fs::path linked = root / "code_sign_clone.SymLnk";
    fs::create_directory_symlink(outside, linked);
    auto bad_marker = clones::CreateSession(root.string());
    std::string bad_marker_path = bad_marker.path;
    bad_marker.lease = clones::Fd();
    fs::remove(fs::path(bad_marker_path) / clones::kLeaseName);
    fs::create_symlink(outside / "lease", fs::path(bad_marker_path) / clones::kLeaseName);
    Require(clones::Cleanup(root.string()) == 0 && fs::is_symlink(linked) && fs::exists(bad_marker_path), "symlink ownership accepted");
    Require(clones::Cleanup(root.string(), "../bad") == 0 && clones::Cleanup(root.string(), "/badxx") == 0, "invalid suffix accepted");
    fs::create_directory_symlink(root, fixture / "root-link");
    Require(!clones::CreateSession((fixture / "root-link").string()).lease.valid(), "root symlink accepted");
    Require(clones::Cleanup((fixture / "root-link").string()) == 0, "cleanup followed root symlink");
    Require(!clones::CreateSession((root / ".." / "outside").string()).lease.valid(), "parent traversal accepted");
    chmod(root.c_str(), 0755);
    Require(clones::Cleanup(root.string()) == 0 && !clones::CreateSession(root.string()).lease.valid(), "unsafe root permissions accepted");
    chmod(root.c_str(), 0700);
    auto hardlinked = clones::CreateSession(root.string());
    std::string hardlinked_path = hardlinked.path;
    hardlinked.lease = clones::Fd();
    fs::create_hard_link(fs::path(hardlinked_path) / clones::kLeaseName, outside / "hardlinked-lease");
    auto permissive = clones::CreateSession(root.string());
    std::string permissive_path = permissive.path;
    permissive.lease = clones::Fd();
    chmod((fs::path(permissive_path) / clones::kLeaseName).c_str(), 0644);
    Require(clones::Cleanup(root.string()) == 0 && fs::exists(hardlinked_path) && fs::exists(permissive_path), "unsafe lease accepted");
    auto nested = clones::CreateSession(root.string());
    std::string nested_path = nested.path;
    nested.lease = clones::Fd();
    fs::create_directory(fs::path(nested_path) / "payload");
    fs::create_directory_symlink(outside, fs::path(nested_path) / "payload/link");
    Require(clones::Cleanup(root.string()) == 1 && fs::exists(outside / "sentinel"), "payload symlink followed");
    std::cout << "PASS legacy, invalid paths, symlinks, hardlinks and ownership modes\n";

    fs::path bounded_root = fixture / "bounded";
    for (int i = 0; i < 5; ++i) {
      auto session = clones::CreateSession(bounded_root.string());
      Require(session.lease.valid(), "bounded session creation");
      Write(fs::path(session.path) / "payload", "remove");
    }
    clones::Limits limits;
    limits.sessions = 2;
    Require(clones::Cleanup(bounded_root.string(), {}, limits) == 2, "session budget exceeded");
    Require(clones::Cleanup(bounded_root.string(), {}, limits) == 2, "second bounded sweep failed");
    Require(clones::Cleanup(bounded_root.string(), {}, limits) == 1, "final bounded sweep failed");
    Require(clones::Cleanup(bounded_root.string()) == 0, "bounded cleanup not idempotent");
    auto partial = clones::CreateSession(bounded_root.string());
    std::string partial_path = partial.path;
    partial.lease = clones::Fd();
    for (int i = 0; i < 4; ++i) Write(fs::path(partial_path) / std::to_string(i), "partial");
    limits.nodes = 1;
    Require(clones::Cleanup(bounded_root.string(), {}, limits) == 0 && fs::exists(fs::path(partial_path) / clones::kLeaseName), "partial cleanup discarded lease");
    Require(clones::Cleanup(bounded_root.string()) == 1, "partial cleanup did not resume");
    auto many = clones::CreateSession(bounded_root.string());
    std::string many_path = many.path;
    many.lease = clones::Fd();
    for (int i = 0; i < 600; ++i) Write(fs::path(many_path) / std::to_string(i), "directory iteration");
    for (int attempt = 0; fs::exists(many_path) && attempt < 12; ++attempt) {
      Require(fs::exists(fs::path(many_path) / clones::kLeaseName), "partial sweep lost ownership marker");
      clones::Cleanup(bounded_root.string());
    }
    Require(!fs::exists(many_path), "large clone cleanup did not converge");
    limits.duration = std::chrono::milliseconds(0);
    Require(clones::Cleanup(root.string(), {}, limits) == 0 && fs::exists(active.path), "zero deadline ignored");
    limits = {};
    limits.entries = 0;
    Require(clones::Cleanup(root.string(), {}, limits) == 0, "entry budget ignored");
    std::cout << "PASS session, node, entry and deadline budgets; resumable partial cleanup\n";

    int release[2], published[2];
    Require(pipe(release) == 0 && pipe(published) == 0, "concurrent owner pipes");
    for (int i = 0; i < 4; ++i) {
      pid_t creator = fork();
      Require(creator >= 0, "concurrent creator fork");
      if (creator == 0) {
        close(release[1]);
        close(published[0]);
        auto session = clones::CreateSession(bounded_root.string());
        char result = session.lease.valid() ? 'Y' : 'N';
        if (write(published[1], &result, 1) != 1) _exit(4);
        close(published[1]);
        char ignored;
        if (read(release[0], &ignored, 1) != 0) _exit(5);
        _exit(result == 'Y' ? 0 : 6);
      }
      children.push_back(creator);
    }
    close(release[0]);
    close(published[1]);
    for (int i = 0; i < 4; ++i) {
      char result;
      Require(read(published[0], &result, 1) == 1 && result == 'Y', "concurrent creation failed");
    }
    close(published[0]);
    Require(clones::Cleanup(bounded_root.string()) == 0, "concurrent active owners removed");
    close(release[1]);
    for (pid_t creator : children) {
      int status;
      Require(waitpid(creator, &status, 0) == creator && WIFEXITED(status) && WEXITSTATUS(status) == 0, "concurrent owner failed");
    }
    children.clear();
    Require(clones::Cleanup(bounded_root.string()) == 4, "concurrent released owners retained");
    std::cout << "PASS concurrent creators and cleanup with four active owners\n";

    fs::path app = fixture / "Test.app";
    fs::create_directories(app / "Contents/MacOS");
    Write(app / "Contents/MacOS/Test", "fixture executable");
    Write(app / "Contents/Info.plist", "fixture info");
    int ready[2];
    Require(pipe(ready) == 0, "child ready pipe");
    pid_t child = fork();
    Require(child >= 0, "fork session owner");
    if (child == 0) {
      close(ready[0]);
      auto session = clones::CreateSession(root.string());
      fs::path clone = fs::path(session.path) / "Test.app.bundle";
      if (!session.lease.valid() || clonefile(app.c_str(), clone.c_str(), 0) != 0 ||
          unlink((clone / "Contents/MacOS/Test").c_str()) != 0 ||
          link((app / "Contents/MacOS/Test").c_str(), (clone / "Contents/MacOS/Test").c_str()) != 0) _exit(2);
      // The native manager deliberately retains this descriptor until process death.
      (void)session.lease.release();
      if (write(ready[1], session.path.c_str(), session.path.size() + 1) < 0) _exit(3);
      close(ready[1]);
      while (true) pause();
    }
    children.push_back(child);
    close(ready[1]);
    char child_path[4096];
    ssize_t received = read(ready[0], child_path, sizeof(child_path));
    close(ready[0]);
    Require(received > 0 && child_path[received - 1] == '\0', "native child did not initialize");
    fs::path native_clone = fs::path(child_path) / "Test.app.bundle";
    struct stat original_info, clone_info;
    Require(stat((app / "Contents/MacOS/Test").c_str(), &original_info) == 0 &&
            stat((native_clone / "Contents/MacOS/Test").c_str(), &clone_info) == 0 &&
            original_info.st_ino == clone_info.st_ino && original_info.st_dev == clone_info.st_dev,
            "native executable hardlink not preserved");
    Require(clones::Cleanup(root.string()) == 0 && fs::exists(native_clone / "Contents/Info.plist"), "live native session removed");
    Require(kill(child, SIGKILL) == 0, "forced owner exit");
    int status;
    Require(waitpid(child, &status, 0) == child && WIFSIGNALED(status), "owner exit not observed");
    children.clear();
    Require(clones::Cleanup(root.string()) == 1 && !fs::exists(child_path), "crashed native clone retained");
    Require(fs::exists(active.path) && fs::exists(unknown) && fs::exists(outside / "sentinel"), "native cleanup damaged retained data");
    Require(clones::Cleanup(root.string()) == 0, "post-crash cleanup not idempotent");
    std::cout << "PASS native APFS clone + executable hardlink, live process lease, forced exit and cleanup\n";
  } catch (const std::exception& error) {
    for (pid_t child : children) { kill(child, SIGKILL); waitpid(child, nullptr, 0); }
    std::cerr << "FAIL: " << error.what() << "\n";
    fs::remove_all(fixture);
    return 1;
  }
  fs::remove_all(fixture);
  return 0;
}
