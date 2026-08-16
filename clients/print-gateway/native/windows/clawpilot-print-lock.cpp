#define UNICODE
#define _UNICODE
#include <windows.h>

#include <cwctype>
#include <string>
#include <vector>

namespace {

constexpr DWORD kInvalidArguments = 74;
constexpr DWORD kLockTimeout = 75;
constexpr DWORD kChildLaunchFailed = 76;

bool IsValidMutexName(const std::wstring& value) {
  const std::wstring prefix = L"ClawPilotPrintEndpoint_";
  if (value.size() != prefix.size() + 64 || value.rfind(prefix, 0) != 0) return false;
  for (size_t index = prefix.size(); index < value.size(); ++index) {
    const wchar_t character = value[index];
    if (!((character >= L'0' && character <= L'9') || (character >= L'a' && character <= L'f'))) {
      return false;
    }
  }
  return true;
}

std::wstring QuoteWindowsArgument(const std::wstring& value) {
  if (!value.empty() && value.find_first_of(L" \t\n\v\"") == std::wstring::npos) return value;
  std::wstring quoted = L"\"";
  size_t backslashes = 0;
  for (const wchar_t character : value) {
    if (character == L'\\') {
      ++backslashes;
      continue;
    }
    if (character == L'\"') {
      quoted.append(backslashes * 2 + 1, L'\\');
      quoted.push_back(L'\"');
    } else {
      quoted.append(backslashes, L'\\');
      quoted.push_back(character);
    }
    backslashes = 0;
  }
  quoted.append(backslashes * 2, L'\\');
  quoted.push_back(L'\"');
  return quoted;
}

}  // namespace

int wmain(int argc, wchar_t* argv[]) {
  std::wstring mutex_name;
  std::wstring command;
  DWORD timeout_ms = 0;
  std::vector<std::wstring> command_arguments;

  int index = 1;
  while (index < argc) {
    const std::wstring argument = argv[index];
    if (argument == L"--") {
      ++index;
      while (index < argc) command_arguments.emplace_back(argv[index++]);
      break;
    }
    if (index + 1 >= argc) return kInvalidArguments;
    const std::wstring value = argv[index + 1];
    if (argument == L"--mutex-name") mutex_name = value;
    else if (argument == L"--command") command = value;
    else if (argument == L"--timeout-ms") {
      try {
        const unsigned long parsed = std::stoul(value);
        if (parsed < 1000 || parsed > 60000) return kInvalidArguments;
        timeout_ms = static_cast<DWORD>(parsed);
      } catch (...) {
        return kInvalidArguments;
      }
    } else return kInvalidArguments;
    index += 2;
  }

  if (!IsValidMutexName(mutex_name) || command.empty() || timeout_ms == 0) {
    return kInvalidArguments;
  }

  const std::wstring kernel_name = L"Local\\" + mutex_name;
  HANDLE mutex = CreateMutexW(nullptr, FALSE, kernel_name.c_str());
  if (mutex == nullptr) return GetLastError();
  const DWORD wait_result = WaitForSingleObject(mutex, timeout_ms);
  if (wait_result == WAIT_TIMEOUT) {
    CloseHandle(mutex);
    return kLockTimeout;
  }
  if (wait_result != WAIT_OBJECT_0 && wait_result != WAIT_ABANDONED) {
    const DWORD error = GetLastError();
    CloseHandle(mutex);
    return error == ERROR_SUCCESS ? kChildLaunchFailed : error;
  }

  std::wstring command_line = QuoteWindowsArgument(command);
  for (const std::wstring& child_argument : command_arguments) {
    command_line.push_back(L' ');
    command_line.append(QuoteWindowsArgument(child_argument));
  }
  std::vector<wchar_t> mutable_command_line(command_line.begin(), command_line.end());
  mutable_command_line.push_back(L'\0');

  STARTUPINFOW startup_info{};
  startup_info.cb = sizeof(startup_info);
  startup_info.dwFlags = STARTF_USESTDHANDLES;
  startup_info.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
  startup_info.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
  startup_info.hStdError = GetStdHandle(STD_ERROR_HANDLE);
  PROCESS_INFORMATION process_info{};
  HANDLE job = CreateJobObjectW(nullptr, nullptr);
  if (job == nullptr) {
    ReleaseMutex(mutex);
    CloseHandle(mutex);
    return kChildLaunchFailed;
  }
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION job_limits{};
  job_limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(
          job, JobObjectExtendedLimitInformation, &job_limits, sizeof(job_limits))) {
    CloseHandle(job);
    ReleaseMutex(mutex);
    CloseHandle(mutex);
    return kChildLaunchFailed;
  }
  const BOOL created = CreateProcessW(
      command.c_str(), mutable_command_line.data(), nullptr, nullptr, TRUE,
      CREATE_NO_WINDOW | CREATE_SUSPENDED, nullptr, nullptr, &startup_info, &process_info);
  if (!created) {
    CloseHandle(job);
    ReleaseMutex(mutex);
    CloseHandle(mutex);
    return kChildLaunchFailed;
  }

  if (!AssignProcessToJobObject(job, process_info.hProcess)) {
    TerminateProcess(process_info.hProcess, kChildLaunchFailed);
    WaitForSingleObject(process_info.hProcess, INFINITE);
    CloseHandle(process_info.hThread);
    CloseHandle(process_info.hProcess);
    CloseHandle(job);
    ReleaseMutex(mutex);
    CloseHandle(mutex);
    return kChildLaunchFailed;
  }
  if (ResumeThread(process_info.hThread) == static_cast<DWORD>(-1)) {
    TerminateProcess(process_info.hProcess, kChildLaunchFailed);
    WaitForSingleObject(process_info.hProcess, INFINITE);
    CloseHandle(process_info.hThread);
    CloseHandle(process_info.hProcess);
    CloseHandle(job);
    ReleaseMutex(mutex);
    CloseHandle(mutex);
    return kChildLaunchFailed;
  }

  WaitForSingleObject(process_info.hProcess, INFINITE);
  DWORD child_exit_code = kChildLaunchFailed;
  GetExitCodeProcess(process_info.hProcess, &child_exit_code);
  CloseHandle(process_info.hThread);
  CloseHandle(process_info.hProcess);
  CloseHandle(job);
  ReleaseMutex(mutex);
  CloseHandle(mutex);
  return static_cast<int>(child_exit_code);
}
