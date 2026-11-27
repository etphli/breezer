#include <windows.h>

#include <memory>
#include <string>
#include <string_view>
#include <vector>

#include "components/breezer_ai_windows/host_identity.h"

namespace {

struct CloseHandle {
  void operator()(HANDLE handle) const { ::CloseHandle(handle); }
};

using ScopedHandle = std::unique_ptr<void, CloseHandle>;

std::wstring HostDirectory() {
  std::wstring path(32768, L'\0');
  const DWORD length = ::GetModuleFileNameW(nullptr, path.data(),
                                            static_cast<DWORD>(path.size()));
  if (length == 0 || length >= path.size()) {
    return {};
  }
  path.resize(length);
  const auto separator = path.rfind(L'\\');
  return separator == std::wstring::npos ? std::wstring()
                                         : path.substr(0, separator);
}

bool IsPackagedPath(const std::wstring& path, bool directory) {
  const DWORD attributes = ::GetFileAttributesW(path.c_str());
  return attributes != INVALID_FILE_ATTRIBUTES &&
         (attributes & FILE_ATTRIBUTE_REPARSE_POINT) == 0 &&
         ((attributes & FILE_ATTRIBUTE_DIRECTORY) != 0) == directory;
}

ScopedHandle InheritHandle(HANDLE source) {
  HANDLE duplicate = nullptr;
  if (source == nullptr || source == INVALID_HANDLE_VALUE ||
      !::DuplicateHandle(::GetCurrentProcess(), source, ::GetCurrentProcess(),
                         &duplicate, 0, TRUE, DUPLICATE_SAME_ACCESS)) {
    return {};
  }
  return ScopedHandle(duplicate);
}

ScopedHandle StderrForChild() {
  auto error = InheritHandle(::GetStdHandle(STD_ERROR_HANDLE));
  if (error) {
    return error;
  }
  SECURITY_ATTRIBUTES attributes{};
  attributes.nLength = sizeof(attributes);
  attributes.bInheritHandle = TRUE;
  HANDLE sink =
      ::CreateFileW(L"NUL", GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
                    &attributes, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  return ScopedHandle(sink == INVALID_HANDLE_VALUE ? nullptr : sink);
}

bool ClearEnvironmentVariable(const wchar_t* name) {
  return ::SetEnvironmentVariableW(name, nullptr) ||
         ::GetLastError() == ERROR_ENVVAR_NOT_FOUND;
}

bool IsParentWindowArgument(std::wstring_view argument) {
  constexpr std::wstring_view prefix = L"--parent-window=";
  return argument.starts_with(prefix) && argument.size() > prefix.size() &&
         argument.find_first_not_of(L"0123456789", prefix.size()) ==
             std::wstring_view::npos;
}

}  // namespace

int wmain(int argc, wchar_t* argv[]) {
  // Chromium can append a parent window after the origin.
  if (argc < 2 || argc > 3 ||
      std::wstring_view(argv[1]) != kBreezerAiExtensionOrigin ||
      (argc == 3 && !IsParentWindowArgument(argv[2]))) {
    return 1;
  }
  const std::wstring directory = HostDirectory();
  if (directory.empty()) {
    return 1;
  }
  const std::wstring runtime = directory + L"\\runtime";
  const std::wstring host = directory + L"\\host";
  const std::wstring node = runtime + L"\\node.exe";
  const std::wstring script = host + L"\\main.mjs";
  if (!IsPackagedPath(directory, true) || !IsPackagedPath(runtime, true) ||
      !IsPackagedPath(host, true) || !IsPackagedPath(node, false) ||
      !IsPackagedPath(script, false) ||
      !ClearEnvironmentVariable(L"NODE_OPTIONS") ||
      !ClearEnvironmentVariable(L"NODE_PATH")) {
    return 1;
  }

  auto input = InheritHandle(::GetStdHandle(STD_INPUT_HANDLE));
  auto output = InheritHandle(::GetStdHandle(STD_OUTPUT_HANDLE));
  auto error = StderrForChild();
  if (!input || !output || !error ||
      ::GetFileType(input.get()) != FILE_TYPE_PIPE ||
      ::GetFileType(output.get()) != FILE_TYPE_PIPE) {
    return 1;
  }
  HANDLE inherited_handles[] = {input.get(), output.get(), error.get()};

  ScopedHandle job(::CreateJobObjectW(nullptr, nullptr));
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!job ||
      !::SetInformationJobObject(job.get(), JobObjectExtendedLimitInformation,
                                 &limits, sizeof(limits))) {
    return 1;
  }

  SIZE_T attribute_bytes = 0;
  ::InitializeProcThreadAttributeList(nullptr, 2, 0, &attribute_bytes);
  if (attribute_bytes == 0) {
    return 1;
  }
  std::vector<BYTE> attribute_storage(attribute_bytes);
  auto attributes =
      reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attribute_storage.data());
  if (!::InitializeProcThreadAttributeList(attributes, 2, 0,
                                           &attribute_bytes)) {
    return 1;
  }

  STARTUPINFOEXW startup{};
  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = input.get();
  startup.StartupInfo.hStdOutput = output.get();
  startup.StartupInfo.hStdError = error.get();
  startup.lpAttributeList = attributes;
  PROCESS_INFORMATION process{};

  // Chromium and Node both use these pipes for binary native messaging frames.
  // A kernel job binds Node and its descendants to the launcher from creation.
  HANDLE job_handle = job.get();
  std::wstring command =
      L"\"" + node + L"\" \"" + script + L"\" " + kBreezerAiExtensionOrigin;
  const bool started =
      ::UpdateProcThreadAttribute(
          attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited_handles,
          sizeof(inherited_handles), nullptr, nullptr) &&
      ::UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST,
                                  &job_handle, sizeof(job_handle), nullptr,
                                  nullptr) &&
      ::CreateProcessW(node.c_str(), command.data(), nullptr, nullptr, TRUE,
                       CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT, nullptr,
                       directory.c_str(), &startup.StartupInfo, &process);
  ::DeleteProcThreadAttributeList(attributes);
  if (!started) {
    return 1;
  }
  ScopedHandle child(process.hProcess);
  ::CloseHandle(process.hThread);

  DWORD exit_code = 1;
  if (::WaitForSingleObject(child.get(), INFINITE) != WAIT_OBJECT_0 ||
      !::GetExitCodeProcess(child.get(), &exit_code)) {
    return 1;
  }
  return static_cast<int>(exit_code);
}
